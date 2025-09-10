import fetch from "node-fetch";

/**
 * Initiate Payment with Paystack
 * Works with Appwrite Functions (new runtime).
 */
export default async ({ req, res, log, error }) => {
  try {
    log("--- Initiate Payment Function Started ---");

    // Parse request body
    const { amount, email, currency = "GHS" } = req.body;

    if (!amount || !email) {
      throw new Error("Amount and email are required in the request body.");
    }

    log(`Received request to fund ${amount} ${currency} for ${email}`);

    // Get Paystack Secret Key
    const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!paystackSecretKey) {
      throw new Error(
        "Paystack secret key is not configured in function settings."
      );
    }

    // Prepare request to Paystack
    const response = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${paystackSecretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          amount: Math.round(amount * 100), // Paystack works in kobo/pesewas
          currency,
        }),
      }
    );

    const data = await response.json();

    if (!data.status) {
      throw new Error(`Paystack API Error: ${data.message}`);
    }

    log("✅ Successfully initiated payment with Paystack.");

    return res.json(
      {
        success: true,
        message: "Payment initialized successfully",
        data: data.data,
      },
      200
    );
  } catch (err) {
    error(`❌ Function failed: ${err.message}`);
    return res.json({ success: false, message: err.message }, 500);
  }
};
