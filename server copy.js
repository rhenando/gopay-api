require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const admin = require("firebase-admin");

const app = express();
app.use(express.json()); // Ensure JSON body is parsed
app.use(express.urlencoded({ extended: true })); // Allow form-encoded data
app.use(cors()); // Allow requests from frontend

// ✅ Default Route (Fixes "Cannot GET /" error)
app.get("/", (req, res) => {
  res.send("🚀 GoPay API is Running!");
});

// ✅ Initialize Firebase Admin SDK
const serviceAccount = require("./serviceAccountKey.json"); // Replace with your Firebase key file
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// ✅ Load GoPay API credentials from `.env`
const API_BASE_URL = process.env.API_BASE_URL;
const API_USERNAME = process.env.GOPAY_USERNAME;
const API_PASSWORD = process.env.GOPAY_PASSWORD;
const ENTITY_ACTIVITY_ID = process.env.ENTITY_ACTIVITY_ID;

// ✅ Function to Fetch Payment Info with Enhanced Logging
const fetchPaymentInfo = async (billNumber) => {
  try {
    console.log(`🔍 Fetching Payment Info for Bill Number: ${billNumber}`);

    const headers = {
      "Content-Type": "application/json",
      username: API_USERNAME,
      password: API_PASSWORD,
    };

    const response = await axios.get(
      `${API_BASE_URL}/bill/info?billNumber=${billNumber}`,
      { headers }
    );

    console.log(
      "✅ Full Payment Info Response:",
      JSON.stringify(response.data, null, 2)
    );
    return response.data;
  } catch (error) {
    console.error(
      "🔥 Error fetching payment info:",
      error.response?.data || error.message
    );
    return null;
  }
};

// ✅ Checkout API: Create an Invoice on GoPay
app.post("/api/create-invoice", async (req, res) => {
  try {
    const headers = {
      "Content-Type": "application/json",
      username: API_USERNAME,
      password: API_PASSWORD,
    };

    const invoiceRequest = {
      billNumber: req.body.billNumber || String(new Date().getTime()),
      entityActivityId: ENTITY_ACTIVITY_ID,
      customerFullName: req.body.customerFullName || "Unknown Buyer",
      customerEmailAddress:
        req.body.customerEmailAddress || "billing@marsos.com.sa",
      customerMobileNumber: req.body.customerMobileNumber || "966500000000",
      issueDate: req.body.issueDate || new Date().toISOString().split("T")[0],
      expireDate:
        req.body.expireDate ||
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
      serviceName: req.body.serviceName || "General Service",
      billItemList: req.body.billItemList || [],
      totalAmount: (Number(req.body.totalAmount) || 0).toFixed(2),
      isPublicView: true,
      showOnlinePayNowButton: true, // ✅ Ensure online payment button is enabled
    };

    console.log(
      "📡 Sending Invoice Request to GoPay:",
      JSON.stringify(invoiceRequest, null, 2)
    );

    const response = await axios.post(
      `${API_BASE_URL}/simple/upload`,
      invoiceRequest,
      { headers }
    );

    console.log(
      "✅ GoPay API Response:",
      JSON.stringify(response.data, null, 2)
    );

    if (response?.data?.data?.billNumber) {
      const billNumber = response.data.data.billNumber;

      console.log(
        `⏳ Waiting 3 seconds before fetching payment info for billNumber: ${billNumber}`
      );
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // ✅ Fetch Payment Info
      const paymentInfoResponse = await fetchPaymentInfo(billNumber);

      let paymentUrl = null;
      if (paymentInfoResponse?.data?.qr) {
        const qrText = paymentInfoResponse.data.qr;
        console.log("🔹 QR Text from API:", qrText);

        // ✅ Extract Payment URL from QR field
        const match = qrText.match(
          /https:\/\/.*\/verify\/bill\?billNumber=[A-Za-z0-9+/=]+/
        );
        paymentUrl = match ? match[0] : null;
      }

      if (!paymentUrl) {
        console.error("❌ Failed to extract payment URL.");
      }

      return res.json({ ...response.data, paymentUrl });
    } else {
      return res
        .status(500)
        .json({ error: "Invoice created, but Payment URL not found." });
    }
  } catch (error) {
    console.error(
      "🔥 Error creating invoice:",
      error.response?.data || error.message
    );
    return res.status(error.response?.status || 500).json({
      error: "Something went wrong",
      details: error.response?.data || error.message,
    });
  }
});

// ✅ Payment Notification Webhook with Debugging
app.post("/api/payment-notification", async (req, res) => {
  try {
    console.log(
      "🔔 Incoming Payment Notification:",
      JSON.stringify(req.body, null, 2)
    );

    const { billNumber, paymentStatus, paymentAmount, paymentDate } = req.body;

    // ✅ Ensure required fields are present
    if (!billNumber || !paymentStatus) {
      console.error("❌ Missing required fields:", req.body);
      return res.status(400).json({ error: "Missing required fields" });
    }

    // ✅ Store in Firestore
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

    console.log(`✅ Payment ${paymentStatus} recorded for Bill: ${billNumber}`);
    res.json({ status: 200, message: "Operation Done Successfully" });
  } catch (error) {
    console.error("🔥 Error handling payment notification:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ✅ Settlement Notification Webhook
app.post("/api/settlement-notification", async (req, res) => {
  try {
    console.log(
      "📩 Incoming Settlement Notification:",
      JSON.stringify(req.body, null, 2)
    );

    const { billNumber, paymentAmount, paymentDate, bankId, settlementStatus } =
      req.body;

    // ✅ Ensure required fields exist
    if (!billNumber || !settlementStatus) {
      console.error("❌ Missing required fields in settlement:", req.body);
      return res.status(400).json({ error: "Missing required fields" });
    }

    // ✅ Store Settlement in Firestore
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

    console.log(`✅ Settlement recorded for Bill: ${billNumber}`);

    // ✅ Respond to GoPay
    res.json({ status: 200, message: "Operation Done Successfully" });
  } catch (error) {
    console.error("🔥 Error handling settlement notification:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ✅ Start the Server
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`🚀 GoPay Server running on port ${PORT}`));
