

# Printify Android

**Android Custom Printing Ecommerce App** built with Flutter + Firebase.

> ⚠️ This is a **production-oriented source foundation**, not a finished, verified production release.  
> The code has not been compiled or fully tested in this environment. Treat it as a solid baseline that still requires setup, validation, and completion of payments & shipping.

---

## Features

### Customer Side
- Email/Password Authentication
- Product Catalogue with search & category filters
- Product Detail (sizes, colours, custom text, artwork upload)
- Cart & Delivery Address
- COD Order Creation
- Order History
- Custom Print Request form (including customer-owned garment requests)

### Admin Side
- Admin-only product publishing
- Order status management
- Role checked securely on the server side

### Backend
- Firebase Authentication
- Cloud Firestore
- Firebase Storage (artwork uploads)
- Cloud Functions (price calculation + transactional stock decrement)
- Restrictive Firestore & Storage security rules
- Razorpay scaffolding (intentionally not fully wired yet)
- Shipping structure prepared (Shiprocket recommended)

---

## Tech Stack

- **Frontend**: Flutter (Dart)
- **Backend**: Firebase (Auth, Firestore, Storage, Cloud Functions)
- **Payments**: Razorpay (scaffolded)
- **Language**: Dart + JavaScript (Cloud Functions)

---

## Prerequisites

Before running the project, make sure you have:

- Flutter (stable channel)
- Android Studio + Android SDK
- Node.js 20+
- Firebase CLI (`npm install -g firebase-tools`)

---

## Setup Instructions

### 1. Clone the repository
```bash
git clone https://github.com/Princesoni000/Printify_android.git
cd Printify_android
