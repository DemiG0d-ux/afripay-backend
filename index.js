// index.js
module.exports = async (req, res) => {
  const { amount, email } = JSON.parse(req.payload);
  const paystackSecretKey = req.variables.PAYSTACK_SECRET_KEY;

  const options = {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${paystackSecretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: email,
      amount: amount * 100,
      currency: 'GHS',
    }),
  };

  try {
    const response = await fetch('https://api.paystack.co/transaction/initialize', options);
    const data = await response.json();
    res.json({ success: true, data: data.data });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
};