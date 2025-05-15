require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const admin = require("firebase-admin");

// ── Load GCP Service Account from ENV ─────────────────────────
if (!process.env.GCP_SERVICE_ACCOUNT_JSON) {
  console.error("❌ GCP_SERVICE_ACCOUNT_JSON is missing");
  process.exit(1);
}
const serviceAccount = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON);

const app = express();

// ── Body parsing & CORS ─────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// ── Healthcheck ─────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("🚀 GoPay API is Running!");
});

// ── Firestore Init ──────────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// ── GoPay Credentials ───────────────────────────────────────
const API_BASE_URL = process.env.API_BASE_URL;
const API_USERNAME = process.env.GOPAY_USERNAME;
const API_PASSWORD = process.env.GOPAY_PASSWORD;
const ENTITY_ACTIVITY_ID = process.env.ENTITY_ACTIVITY_ID;

// ── Helper: Build GoPay line items from your cart ───────────
function buildBillItems(items) {
  return items.map((item) => {
    const unit = Number(item.subtotal / item.quantity).toFixed(2);
    return {
      reference: item.id,
      name: item.productName,
      quantity: item.quantity,
      unitPrice: unit,
      discount: 0,
      vat: "0.15",
    };
  });
}

// ── Create Invoice Endpoint ──────────────────────────────────
app.post("/api/create-invoice", async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      phone,
      email,
      billNumber,
      issueDate,
      expireDate,
      serviceName,
      items,
      amount,
      shippingCost,
    } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Empty cart: no items to bill." });
    }

    const billItemList = buildBillItems(items);

    if (shippingCost && shippingCost > 0) {
      billItemList.push({
        reference: "shipping",
        name: "Shipping",
        quantity: 1,
        unitPrice: Number(shippingCost).toFixed(2),
        discount: 0,
        vat: "0.15",
      });
    }

    const invoiceRequest = {
      billNumber: billNumber || Date.now().toString(),
      entityActivityId: ENTITY_ACTIVITY_ID,
      customerFullName: `${firstName} ${lastName}`.trim() || "Unknown Buyer",
      customerEmailAddress: email || "no-reply@yourdomain.com",
      customerMobileNumber: phone || "0000000000",
      issueDate: issueDate || new Date().toISOString().split("T")[0],
      expireDate:
        expireDate ||
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
      serviceName: serviceName || "Order Payment",
      billItemList,
      totalAmount: Number(amount).toFixed(2),
      isPublicView: true,
      showOnlinePayNowButton: true,
    };

    const headers = {
      "Content-Type": "application/json",
      username: API_USERNAME,
      password: API_PASSWORD,
    };

    const gp = await axios.post(
      `${API_BASE_URL}/simple/upload`,
      invoiceRequest,
      { headers }
    );

    const billNo = gp.data?.data?.billNumber;
    if (!billNo) {
      return res
        .status(500)
        .json({ error: "No billNumber returned by GoPay." });
    }

    // Wait briefly for GoPay to process
    await new Promise((r) => setTimeout(r, 3000));

    const info = await axios.get(
      `${API_BASE_URL}/bill/info?billNumber=${billNo}`,
      { headers }
    );
    const qrText = info.data?.data?.qr || "";
    const redirectUrl =
      (qrText.match(/https:\/\/.*verify\/bill\?billNumber=\w+/) || [])[0] ||
      null;

    return res.json({
      success: true,
      billNumber: billNo,
      redirectUrl,
    });
  } catch (err) {
    console.error(
      "🚨 create-invoice error:",
      err.response?.data || err.message
    );
    return res.status(err.response?.status || 500).json({
      error: err.response?.data || err.message,
    });
  }
});

// ── Payment Notification Webhook ────────────────────────────
app.post("/api/payment-notification", async (req, res) => {
  try {
    const { billNumber, paymentStatus, paymentAmount, paymentDate } = req.body;
    if (!billNumber || !paymentStatus) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const paymentRef = db.collection("payments").doc(billNumber);
    await paymentRef.set(
      {
        paymentStatus,
        paymentAmount: paymentAmount || 0,
        paymentDate: paymentDate || new Date().toISOString(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({ status: 200, message: "Operation Done Successfully" });
  } catch (error) {
    console.error("🔥 Error handling payment notification:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Settlement Notification Webhook ─────────────────────────
app.post("/api/settlement-notification", async (req, res) => {
  try {
    const { billNumber, settlementStatus, paymentAmount, paymentDate, bankId } =
      req.body;
    if (!billNumber || !settlementStatus) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const settlementRef = db.collection("settlements").doc(billNumber);
    await settlementRef.set(
      {
        settlementStatus,
        paymentAmount: paymentAmount || 0,
        paymentDate: paymentDate || new Date().toISOString(),
        bankId: bankId || "Unknown",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({ status: 200, message: "Operation Done Successfully" });
  } catch (error) {
    console.error("🔥 Error handling settlement notification:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Start Server ─────────────────────────────────────────────
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`🚀 GoPay API running on port ${PORT}`));
