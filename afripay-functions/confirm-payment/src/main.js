import { Client, Databases, ID, Permission, Role, Query } from 'node-appwrite';
import crypto from 'crypto';

// This is the main entry point for your webhook function
export default async ({ req, res, log, error }) => {
  try {
    // --- Step 1: Verify the request is actually from Paystack ---
    const secret = process.env.PAYSTACK_WEBHOOK_SECRET;
    const hash = crypto.createHmac('sha512', secret)
                       .update(JSON.stringify(req.body))
                       .digest('hex');
    
    if (hash !== req.headers['x-paystack-signature']) {
      error("Invalid webhook signature.");
      return res.send('Invalid signature', 401);
    }

    const event = req.body;

    // --- Step 2: Check if the payment was successful ---
    if (event.event === 'charge.success') {
      const { amount, customer, currency } = event.data;
      const userEmail = customer.email;
      const amountPaid = amount / 100;

      // --- Setup Appwrite SDK ---
      const client = new Client()
        .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT)
        .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
        .setKey(process.env.APPWRITE_API_KEY);
      const databases = new Databases(client);

      // --- Step 3: Find the user in our database by their email ---
      const userResponse = await databases.listDocuments(
        '686ac6ae001f516e943e', // Your Database ID
        '686acc5e00101633025d', // Your 'users' Collection ID
        [Query.equal('email', userEmail)]
      );

      if (userResponse.total === 0) {
        throw new Error(`User with email ${userEmail} not found.`);
      }

      const user = userResponse.documents[0];
      const userId = user.$id;
      const balanceField = currency === 'GHS' ? 'balanceGHS' : 'balanceNGN';

      // --- Step 4: Calculate and update the new balance ---
      const newBalance = user[balanceField] + amountPaid;
      await databases.updateDocument(
        '686ac6ae001f516e943e',
        '686acc5e00101633025d',
        userId,
        { [balanceField]: newBalance }
      );
      
      // --- Step 5: Create the transaction receipt ---
      await databases.createDocument(
        '686ac6ae001f516e943e',
        '686ef184002bd8d2cca1', // Your 'transactions' Collection ID
        ID.unique(),
        {
          'description': `Wallet Funding via Paystack`,
          'amount': amountPaid,
          'type': 'credit',
          'status': 'Completed',
          'userId': userId,
        },
        [Permission.read(Role.user(userId))]
      );

      log(`Successfully processed payment for ${userEmail}.`);
    }

    // --- Final Step: Tell Paystack everything is okay ---
    return res.send('Webhook received successfully', 200);

  } catch (err) {
    error(`Webhook failed: ${err.message}`);
    return res.send(`Webhook processing failed: ${err.message}`, 500);
  }
};
