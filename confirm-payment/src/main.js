import { Client, Databases, ID, Permission, Role, Query } from 'node-appwrite';
import crypto from 'crypto';

export default async ({ req, res, log, error }) => {
  try {
    log("--- Confirm Payment Webhook Triggered ---");

    // --- Step 1: Verify webhook signature from Paystack ---
    const secret = process.env.PAYSTACK_WEBHOOK_SECRET;
    if (!secret) {
      error("PAYSTACK_WEBHOOK_SECRET is not configured.");
      return res.send("Server misconfigured", 500);
    }

    const computedHash = crypto
      .createHmac("sha512", secret)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (computedHash !== req.headers["x-paystack-signature"]) {
      error("Invalid webhook signature.");
      return res.send("Invalid signature", 401);
    }

    const event = req.body;

    // --- Step 2: Process only successful charges ---
    if (event.event === "charge.success") {
      const { amount, customer, currency } = event.data;
      const userEmail = customer.email;
      const amountPaid = amount / 100;

      // --- Step 3: Setup Appwrite Client ---
      const client = new Client()
        .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT)
        .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
        .setKey(process.env.APPWRITE_API_KEY);

      const databases = new Databases(client);

      // --- Step 4: Find user by email ---
      const userResponse = await databases.listDocuments(
        process.env.DATABASE_ID, // safer than hardcoding IDs
        process.env.USERS_COLLECTION_ID,
        [Query.equal("email", userEmail)]
      );

      if (userResponse.total === 0) {
        throw new Error(`User with email ${userEmail} not found.`);
      }

      const user = userResponse.documents[0];
      const userId = user.$id;
      const balanceField = currency === "GHS" ? "balanceGHS" : "balanceNGN";

      // --- Step 5: Update user balance ---
      const newBalance = (user[balanceField] || 0) + amountPaid;
      await databases.updateDocument(
        process.env.DATABASE_ID,
        process.env.USERS_COLLECTION_ID,
        userId,
        { [balanceField]: newBalance }
      );

      // --- Step 6: Log the transaction ---
      await databases.createDocument(
        process.env.DATABASE_ID,
        process.env.TRANSACTIONS_COLLECTION_ID,
        ID.unique(),
        {
          description: "Wallet Funding via Paystack",
          amount: amountPaid,
          type: "credit",
          status: "Completed",
          userId: userId,
        },
        [Permission.read(Role.user(userId))]
      );

      log(`✅ Payment confirmed and wallet updated for ${userEmail}`);
    }

    // --- Final Step: Always acknowledge Paystack ---
    return res.send("Webhook received successfully", 200);

  } catch (err) {
    error(`❌ Webhook failed: $
