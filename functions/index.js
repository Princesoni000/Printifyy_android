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

function safeHexEqual(received, expected) {
  if (typeof received !== 'string' || !/^[a-f0-9]{64}$/i.test(received)) return false;
  const a = Buffer.from(received, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getRazorpayClient() {
  return new Razorpay({key_id: RAZORPAY_KEY_ID.value(), key_secret: RAZORPAY_KEY_SECRET.value()});
}

async function buildRazorpayCart(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 30) throw new HttpsError('invalid-argument', 'Your cart is empty or too large.');
  const normalized = [];
  const unitsByProduct = new Map();
  let totalPaise = 0;
  for (const item of items) {
    if (!item || typeof item.productId !== 'string' || !item.productId || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20) throw new HttpsError('invalid-argument', 'Invalid cart item.');
    const snap = await db.doc('products/' + item.productId).get();
    if (!snap.exists || snap.get('published') !== true) throw new HttpsError('failed-precondition', 'A product is unavailable.');
    const p = snap.data();
    const stock = Number.isInteger(p.stock) ? p.stock : 0;
    const unitPaise = Math.round(Number(p.price) * 100);
    if (!Number.isSafeInteger(unitPaise) || unitPaise < 0) throw new HttpsError('failed-precondition', 'A product has an invalid price.');
    const used = (unitsByProduct.get(item.productId) || 0) + item.quantity;
    if (used > stock) throw new HttpsError('failed-precondition', 'Insufficient stock for ' + String(p.name || 'a product') + '.');
    unitsByProduct.set(item.productId, used);
    const linePaise = unitPaise * item.quantity;
    totalPaise += linePaise;
    normalized.push({productId: item.productId, name: String(p.name || 'Product').slice(0, 120), unitPrice: unitPaise / 100, quantity: item.quantity, size: String(item.size || '').slice(0, 20), color: String(item.color || '').slice(0, 40), customText: String(item.customText || '').slice(0, 160), artworkUrl: typeof item.artworkUrl === 'string' ? item.artworkUrl.slice(0, 2048) : null, lineTotal: linePaise / 100});
  }
  if (!Number.isSafeInteger(totalPaise) || totalPaise < 100 || totalPaise > 1000000000) throw new HttpsError('invalid-argument', 'The order total is outside Razorpay limits.');
  return {normalized, totalPaise};
}

async function finalizeRazorpayPayment(internalOrderId, providerOrderId, payment) {
  const orderRef = db.doc('orders/' + internalOrderId);
  return db.runTransaction(async tx => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw new Error('Internal order not found.');
    const order = orderSnap.data();
    if (order.paymentMethod !== 'RAZORPAY' || order.razorpayOrderId !== providerOrderId) throw new Error('Payment does not match this order.');
    if (order.amountPaise !== payment.amount || order.currency !== payment.currency || payment.currency !== 'INR') throw new Error('Payment amount or currency does not match this order.');
    if (order.paymentStatus === 'paid') return {alreadyProcessed: true, needsReview: false};
    if (order.paymentStatus === 'paid_stock_conflict') return {alreadyProcessed: true, needsReview: true};
    if (order.paymentStatus !== 'pending') throw new Error('This order is not awaiting payment.');
    const quantities = new Map();
    for (const item of (Array.isArray(order.items) ? order.items : [])) quantities.set(item.productId, (quantities.get(item.productId) || 0) + item.quantity);
    const productIds = Array.from(quantities.keys()).sort();
    const refs = productIds.map(id => db.doc('products/' + id));
    const productSnaps = [];
    for (const ref of refs) productSnaps.push(await tx.get(ref));
    const conflict = productSnaps.some((snap, i) => !snap.exists || snap.get('published') !== true || !Number.isInteger(snap.get('stock')) || snap.get('stock') < quantities.get(productIds[i]));
    if (conflict) {
      tx.update(orderRef, {status: 'payment_review', paymentStatus: 'paid_stock_conflict', razorpayPaymentId: payment.id, paidAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp()});
      return {alreadyProcessed: false, needsReview: true};
    }
    productSnaps.forEach((snap, i) => tx.update(refs[i], {stock: snap.get('stock') - quantities.get(productIds[i]), updatedAt: admin.firestore.FieldValue.serverTimestamp()}));
    tx.update(orderRef, {status: 'placed', paymentStatus: 'paid', razorpayPaymentId: payment.id, paidAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp()});
    return {alreadyProcessed: false, needsReview: false};
  });
}

exports.createRazorpayOrder = onCall({secrets: [RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET]}, async req => {
  const uid = requireUser(req);
  const {items, address} = req.data || {};
  if (typeof address !== 'string' || address.trim().length < 10 || address.length > 1000) throw new HttpsError('invalid-argument', 'Enter a complete delivery address.');
  const cart = await buildRazorpayCart(items);
  const orderRef = db.collection('orders').doc();
  const providerOrder = await getRazorpayClient().orders.create({amount: cart.totalPaise, currency: 'INR', receipt: orderRef.id, notes: {internalOrderId: orderRef.id, userId: uid}});
  const total = cart.totalPaise / 100;
  await orderRef.set({userId: uid, items: cart.normalized, address: address.trim(), subtotal: total, shipping: 0, total, amountPaise: cart.totalPaise, currency: 'INR', paymentMethod: 'RAZORPAY', paymentStatus: 'pending', status: 'awaiting_payment', razorpayOrderId: providerOrder.id, createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp()});
  return {orderId: orderRef.id, razorpayOrderId: providerOrder.id, amount: providerOrder.amount, currency: providerOrder.currency, keyId: RAZORPAY_KEY_ID.value()};
});

exports.verifyRazorpayPayment = onCall({secrets: [RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET]}, async req => {
  const uid = requireUser(req);
  const {orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature} = req.data || {};
  if ([orderId, razorpayOrderId, razorpayPaymentId].some(v => typeof v !== 'string' || !v) || typeof razorpaySignature !== 'string') throw new HttpsError('invalid-argument', 'Payment verification details are incomplete.');
  const orderRef = db.doc('orders/' + orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists || orderSnap.get('userId') !== uid) throw new HttpsError('not-found', 'Order not found.');
  const order = orderSnap.data();
  if (order.paymentMethod !== 'RAZORPAY' || order.razorpayOrderId !== razorpayOrderId) throw new HttpsError('permission-denied', 'Payment does not belong to this order.');
  const expected = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET.value()).update(razorpayOrderId + '|' + razorpayPaymentId).digest('hex');
  if (!safeHexEqual(razorpaySignature, expected)) throw new HttpsError('permission-denied', 'Payment signature is invalid.');
  const client = getRazorpayClient();
  let payment;
  try {
    payment = await client.payments.fetch(razorpayPaymentId);
    if (payment.order_id !== razorpayOrderId || payment.amount !== order.amountPaise || payment.currency !== 'INR') throw new HttpsError('failed-precondition', 'Payment amount or order does not match.');
    if (payment.status === 'authorized') {
      try { payment = await client.payments.capture(razorpayPaymentId, order.amountPaise, 'INR'); }
      catch (captureError) {
        payment = await client.payments.fetch(razorpayPaymentId);
        if (payment.status !== 'captured') throw captureError;
      }
    }
    if (payment.status !== 'captured') throw new HttpsError('failed-precondition', 'Payment has not been captured yet.');
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('unavailable', 'Could not verify payment with Razorpay. Check My Orders before retrying.');
  }
  const outcome = await finalizeRazorpayPayment(orderId, razorpayOrderId, payment);
  return {orderId, status: outcome.needsReview ? 'payment_review' : 'placed', needsReview: outcome.needsReview, alreadyProcessed: outcome.alreadyProcessed};
});

exports.razorpayWebhook = onRequest({secrets: [RAZORPAY_WEBHOOK_SECRET]}, async (req, res) => {
  const signature = req.get('x-razorpay-signature');
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) { res.status(400).send('Missing or invalid signature'); return; }
  const expected = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET.value()).update(req.rawBody).digest('hex');
  if (!safeHexEqual(signature, expected)) { res.status(401).send('Invalid signature'); return; }
  const externalEventId = req.get('x-razorpay-event-id') || crypto.createHash('sha256').update(req.rawBody).digest('hex');
  const eventId = crypto.createHash('sha256').update(String(externalEventId)).digest('hex');
  const eventRef = db.collection('paymentWebhookEvents').doc(eventId);
  try {
    const event = String(req.body && req.body.event || 'unknown');
    const payment = req.body && req.body.payload && req.body.payload.payment && req.body.payload.payment.entity;
    let matchedOrderId = null;
    let outcome = null;
    if (event === 'payment.captured' && payment && typeof payment.order_id === 'string' && typeof payment.id === 'string') {
      const matches = await db.collection('orders').where('razorpayOrderId', '==', payment.order_id).limit(1).get();
      if (!matches.empty) {
        matchedOrderId = matches.docs[0].id;
        outcome = await finalizeRazorpayPayment(matchedOrderId, payment.order_id, payment);
      }
    }
    await eventRef.set({event, receivedAt: admin.firestore.FieldValue.serverTimestamp(), processedAt: admin.firestore.FieldValue.serverTimestamp(), orderId: matchedOrderId, paymentStatus: outcome ? (outcome.needsReview ? 'payment_review' : 'paid') : null}, {merge: true});
    res.status(200).send('received');
  } catch (e) {
    console.error('Razorpay webhook processing failed:', e);
    res.status(500).send('Webhook processing failed');
  }
});
