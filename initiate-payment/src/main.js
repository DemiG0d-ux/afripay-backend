import fetch from 'node-fetch';

export default async ({ req, res, log, error }) => {
  try {
    log("--- Initiate Payment Function Started ---");

    // --- REVERTING TO req.payload ---
    // This is the correct way to get data when the Content-Type header is set.
    const { amount, email } = JSON.parse(req.payload);

    if (!amount || !email) {
      throw new Error("Amount and email are required in the request body.");
    }

    log(`Received request to fund ${amount} for ${email}`);

    const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!paystackSecretKey) {
      throw new Error("Paystack secret key is not configured in function settings.");
    }

    const options = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${paystackSecretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, amount: amount * 100, currency: 'GHS' }),
    };

    const response = await fetch('https://api.paystack.co/transaction/initialize', options);
    const data = await response.json();

    if (!data.status) {
      throw new Error(`Paystack API Error: ${data.message}`);
    }

    log("Successfully initiated payment with Paystack.");
    
    return res.json({
      success: true,
      data: data.data,
    });

  } catch (err) {
    error(`Function failed critically: ${err.message}`);
    return res.json({ success: false, message: err.message }, 500);
  }
};
