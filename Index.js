const { onCall, HttpsError, onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const Razorpay = require('razorpay');
const crypto = require('crypto');
admin.initializeApp();
const db = admin.firestore();
const RAZORPAY_KEY_ID = defineSecret('RAZORPAY_KEY_ID');
const RAZORPAY_KEY_SECRET = defineSecret('RAZORPAY_KEY_SECRET');
const RAZORPAY_WEBHOOK_SECRET = defineSecret('RAZORPAY_WEBHOOK_SECRET');

function requireUser(req) { if (!req.auth) throw new HttpsError('unauthenticated', 'Please sign in first.'); return req.auth.uid; }
async function requireAdmin(uid) { const snap = await db.doc(`users/${uid}`).get(); if (!snap.exists || snap.get('role') !== 'admin') throw new HttpsError('permission-denied', 'Admin access required.'); }

exports.isAdmin = onCall(async req => { const uid = requireUser(req); const snap = await db.doc(`users/${uid}`).get(); return { isAdmin: snap.exists && snap.get('role') === 'admin' }; });

exports.adminCreateProduct = onCall(async req => {
  const uid = requireUser(req); await requireAdmin(uid);
  const p = req.data || {};
  if (typeof p.name !== 'string' || !p.name.trim() || !Number.isFinite(p.price) || p.price < 0 || !Number.isInteger(p.stock) || p.stock < 0) throw new HttpsError('invalid-argument', 'Invalid product fields.');
  const allowedCategories = ['T-shirts', 'Lowers', 'Keychains'];
  if (!allowedCategories.includes(p.category)) throw new HttpsError('invalid-argument', 'Invalid category.');
  const doc = await db.collection('products').add({ name: p.name.trim().slice(0,120), description: String(p.description || '').slice(0,2000), category:p.category, price:Math.round(p.price*100)/100, stock:p.stock, sizes:Array.isArray(p.sizes)?p.sizes.slice(0,12):[], colors:Array.isArray(p.colors)?p.colors.slice(0,20):[], imageUrl:typeof p.imageUrl==='string'?p.imageUrl:null, published:p.published===true, customizable:p.customizable===true, createdAt:admin.firestore.FieldValue.serverTimestamp(), updatedAt:admin.firestore.FieldValue.serverTimestamp() });
  return { productId: doc.id };
});

exports.adminUpdateOrder = onCall(async req => {
  const uid = requireUser(req); await requireAdmin(uid);
  const { orderId, status } = req.data || {};
  const allowed = ['confirmed','printing','shipped','delivered','cancelled'];
  if (typeof orderId !== 'string' || !allowed.includes(status)) throw new HttpsError('invalid-argument','Invalid order update.');
  const ref = db.doc(`orders/${orderId}`); const snap = await ref.get(); if(!snap.exists) throw new HttpsError('not-found','Order not found.');
  await ref.update({status, updatedAt:admin.firestore.FieldValue.serverTimestamp()}); return {ok:true};
});

exports.createOrder = onCall(async req => {
  const uid = requireUser(req); const {items,address,paymentMethod} = req.data || {};
  if (!Array.isArray(items) || items.length < 1 || items.length > 30 || typeof address !== 'string' || address.trim().length < 10 || address.length > 1000) throw new HttpsError('invalid-argument','Invalid cart or delivery address.');
  if (!['COD','RAZORPAY'].includes(paymentMethod)) throw new HttpsError('invalid-argument','Invalid payment method.');
  if (paymentMethod === 'RAZORPAY') throw new HttpsError('failed-precondition','Online payments are not enabled yet. Configure Razorpay secrets and complete the payment verification integration before accepting online payments. Choose Cash on Delivery for now.');
  const normalized=[]; let total=0;
  for (const item of items) {
    if (typeof item.productId !== 'string' || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20) throw new HttpsError('invalid-argument','Invalid cart item.');
    const productRef=db.doc(`products/${item.productId}`); const pSnap=await productRef.get();
    if(!pSnap.exists || pSnap.get('published')!==true) throw new HttpsError('failed-precondition','A product is unavailable.');
    const p=pSnap.data(); if((p.stock||0)<item.quantity) throw new HttpsError('failed-precondition',`Insufficient stock for ${p.name}.`);
    const lineTotal=Math.round(Number(p.price)*100)/100*item.quantity; total+=lineTotal;
    normalized.push({productId:item.productId,name:p.name,unitPrice:p.price,quantity:item.quantity,size:String(item.size||'').slice(0,20),color:String(item.color||'').slice(0,40),customText:String(item.customText||'').slice(0,160),artworkUrl:typeof item.artworkUrl==='string'?item.artworkUrl:null,lineTotal});
  }
  // Atomic stock reservation + order creation prevents overselling under concurrent checkout.
  const orderRef=db.collection('orders').doc();
  await db.runTransaction(async tx=>{
    const refs=normalized.map(i=>db.doc(`products/${i.productId}`)); const snaps=[];
    for(const ref of refs) snaps.push(await tx.get(ref));
    snaps.forEach((s,i)=>{if(!s.exists||s.get('published')!==true||(s.get('stock')||0)<normalized[i].quantity)throw new HttpsError('failed-precondition','Stock changed. Please review your cart.');});
    snaps.forEach((s,i)=>tx.update(refs[i],{stock:s.get('stock')-normalized[i].quantity,updatedAt:admin.firestore.FieldValue.serverTimestamp()}));
    tx.set(orderRef,{userId:uid,items:normalized,address:address.trim(),subtotal:Math.round(total*100)/100,shipping:0,total:Math.round(total*100)/100,paymentMethod:'COD',paymentStatus:'pending',status:'placed',createdAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
  });
  return {orderId:orderRef.id};
});

// Creates an order with Razorpay, but does not itself mark an order paid.
// Production checkout must verify signature server-side and reconcile webhook events.
exports.createRazorpayOrder = onCall({secrets:[RAZORPAY_KEY_ID,RAZORPAY_KEY_SECRET]}, async req => {
  const uid=requireUser(req); const amount=req.data?.amount;
  if(!Number.isInteger(amount)||amount<100) throw new HttpsError('invalid-argument','Amount must be an integer in paise.');
  const instance=new Razorpay({key_id:RAZORPAY_KEY_ID.value(),key_secret:RAZORPAY_KEY_SECRET.value()});
  const order=await instance.orders.create({amount,currency:'INR',receipt:`printify_${uid.slice(0,8)}_${Date.now()}`});
  return {id:order.id,amount:order.amount,currency:order.currency,keyId:RAZORPAY_KEY_ID.value()};
});

exports.razorpayWebhook = onRequest({secrets:[RAZORPAY_WEBHOOK_SECRET]}, async (req,res)=>{
  const signature=req.get('x-razorpay-signature'); if(!signature){res.status(400).send('Missing signature');return;}
  const expected=crypto.createHmac('sha256',RAZORPAY_WEBHOOK_SECRET.value()).update(req.rawBody).digest('hex');
  if(!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected))){res.status(401).send('Invalid signature');return;}
  // Deliberately does not mark any order paid yet: persist event idempotently and map
  // Razorpay order/payment IDs to our internal order only after checkout linkage is implemented.
  const eventId=req.get('x-razorpay-event-id') || crypto.createHash('sha256').update(req.rawBody).digest('hex');
  await db.collection('paymentWebhookEvents').doc(eventId).set({event:req.body?.event||'unknown',receivedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
  res.status(200).send('received');
});
