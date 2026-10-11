Printify — Android custom-printing ecommerce
This is a production-oriented source foundation, not a finished, verified production release. It includes Flutter customer screens, Firebase Auth, Firestore product/order streams, artwork uploads, admin-only callable functions, server-side price/stock validation, and restrictive Firestore/Storage rules. The current environment does not have Flutter installed, so no APK has been built or device-tested here.
Included
Customer signup/sign-in, product catalogue/search/category filters, product detail, sizes/colours, custom text and artwork upload
Cart, delivery address, COD order creation, order history
Custom-print request form including customer-owned garment requests
Admin-only product publishing and order status changes (admin role checked server-side)
Firebase Cloud Functions with authoritative price calculation and transactional stock decrement
Initial Razorpay order/webhook scaffolding, intentionally not wired into customer checkout until payment-to-internal-order linkage and signature verification are completed
Firestore and Storage security rules
Required before build
Install Flutter stable, Android Studio/Android SDK, Node.js 20 and Firebase CLI.
Create a Firebase project; enable Email/Password Authentication, Firestore and Storage; enable Cloud Functions billing as required.
Generate the Android platform scaffold in this folder with flutter create --platforms=android . (review/merge generated files if prompted), then run flutter pub get, dart format lib, and flutter analyze.
Run flutterfire configure and generate lib/firebase_options.dart if using the FlutterFire-generated setup. Update main.dart to use DefaultFirebaseOptions.currentPlatform as instructed by FlutterFire, or use the configured native Firebase files as appropriate.
Deploy firestore.rules, storage.rules, and functions with firebase deploy.
Create the first admin securely: register your account, then use a trusted one-time admin bootstrap script run from a secure local environment to set users/{UID}.role = "admin". Do not add an admin promotion screen or allow users to change their own role. Remove/disable the bootstrap after use.
Test signup, authorization, uploads, concurrent stock checkout, order permissions, and admin access with Firebase Emulator Suite and a real Android device.
Cloud Functions deploy
cd functions
npm install
cd ..
firebase login
firebase use --add
firebase deploy --only firestore:rules,storage,functions
Build APK
flutter create --platforms=android .
flutter pub get
flutterfire configure
dart format lib
dart analyze
flutter build apk --release
APK output normally: build/app/outputs/flutter-apk/app-release.apk.
Payment and shipping release blockers
Razorpay: set secrets with firebase functions:secrets:set RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, and RAZORPAY_WEBHOOK_SECRET. Do not launch online payments until checkout creates a server-side internal order, amount is derived from server-side product data, payment signature is verified server-side, webhook events are idempotently linked to the order, and failed/duplicate/refund paths are tested. Current app intentionally rejects Razorpay checkout rather than pretending it works.
Shipping: choose and open a Shiprocket (or other carrier) merchant account; implement authenticated server-side shipment creation after order confirmation, persist AWB/label/tracking URL, process signed/verified tracking webhooks, and handle cancellations/returns. No shipping API credentials are included, so shipping is not yet operational.
Add privacy policy, terms, return/refund policy, support contact, GST/invoice decisions, product/content moderation, logs/alerts, backups, crash reporting, rate limits, and production security review.
Important honest status
This code has not been compiled or audited in this environment. Treat it as an implementation baseline requiring setup, validation, completion of online payments/shipping, and testing—not as an already-ready production app or a generated APK. Never use real customer data until the above checks pass.
