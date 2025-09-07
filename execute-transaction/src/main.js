import { Client, Databases, Users, ID } from 'node-appwrite';
import fetch from 'node-fetch';

// This is your Appwrite function template.
// It's executed each time a server event is triggered.
export default async ({ req, res, log, error }) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_CUSTOM_ENDPOINT || 'https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const databases = new Databases(client);
  const users = new Users(client);

  // You can log messages to the console
  log('Executing transaction function...');

  // `req.payload` contains the data sent from your Flutter app.
  const payload = JSON.parse(req.payload);
  const { type, amount, currency, details } = payload;
  const userId = req.headers['x-appwrite-user-id'];

  if (!userId) {
    error('Could not identify the user. Make sure the function is executed by a logged-in user.');
    return res.json({ success: false, error: 'User authentication failed.' }, 401);
  }

  try {
    const userDoc = await databases.getDocument('686ac6ae001f516e943e', '686acc5e00101633025d', userId);
    const balanceField = currency === 'GHS' ? 'balanceGHS' : 'balanceNGN';
    const currentBalance = userDoc[balanceField];

    switch (type) {
      // --- VIRTUAL CARD LOGIC ---
      case 'create-virtual-card': {
        // In a real app, you would call Paystack's "Create Virtual Card" API here.
        // This requires creating a "Customer" on Paystack first.
        // For our MVP, we'll simulate this and store a mock card in the user's document.
        log(`Simulating virtual card creation for user ${userId}...`);
        
        const mockCardDetails = {
          cardId: `vc_${ID.unique()}`,
          cardNumber: `5060 ${Math.floor(1000 + Math.random() * 9000)} ${Math.floor(1000 + Math.random() * 9000)} ${Math.floor(1000 + Math.random() * 9000)}`,
          cvv: `${Math.floor(100 + Math.random() * 900)}`,
          expiryDate: `12/${new Date().getFullYear() + 3}`,
          balance: 0.0,
          currency: currency,
          isActive: true
        };

        await databases.updateDocument(
          '686ac6ae001f516e943e',
          '686acc5e00101633025d',
          userId,
          { virtualCard: mockCardDetails }
        );

        return res.json({ success: true, message: 'Virtual card created successfully!', data: mockCardDetails });
      }

      case 'fund-virtual-card': {
        if (!details || !userDoc.virtualCard) {
           return res.json({ success: false, error: 'No virtual card found to fund.' }, 400);
        }
        if (currentBalance < amount) {
          return res.json({ success: false, error: 'Insufficient wallet balance.' }, 400);
        }

        const newWalletBalance = currentBalance - amount;
        const newCardBalance = (userDoc.virtualCard.balance || 0.0) + amount;

        await databases.updateDocument(
          '686ac6ae001f516e943e',
          '686acc5e00101633025d',
          userId,
          {
            [balanceField]: newWalletBalance,
            'virtualCard.balance': newCardBalance
          }
        );
        
        return res.json({ success: true, message: 'Virtual card funded successfully!' });
      }
      
      case 'p2p-transfer': {
        if (currentBalance < amount) {
          return res.json({ success: false, error: 'Insufficient balance' }, 400);
        }
        const recipientId = details.recipientId;
        const recipientDoc = await databases.getDocument('686ac6ae001f516e943e', '686acc5e00101633025d', recipientId);
        
        const newSenderBalance = currentBalance - amount;
        const newRecipientBalance = recipientDoc[balanceField] + amount;

        // Update sender and recipient balances
        await databases.updateDocument('686ac6ae001f516e943e', '686acc5e00101633025d', userId, { [balanceField]: newSenderBalance });
        await databases.updateDocument('6-86ac6ae001f516e943e', '686acc5e00101633025d', recipientId, { [balanceField]: newRecipientBalance });

        return res.json({ success: true, message: 'Transfer successful' });
      }

      case 'pay-bill': {
         if (currentBalance < amount) {
          return res.json({ success: false, error: 'Insufficient balance' }, 400);
        }
        const newBalance = currentBalance - amount;
        await databases.updateDocument('686ac6ae001f516e943e', '686acc5e00101633025d', userId, { [balanceField]: newBalance });
        log(`Successfully paid ${currency} ${amount} to ${details.biller} for customer ${details.customerId}.`);
        return res.json({ success: true, message: 'Bill payment successful' });
      }

      default:
        return res.json({ success: false, error: 'Invalid transaction type' }, 400);
    }
  } catch (e) {
    error(e);
    return res.json({ success: false, error: e.message }, 500);
  }
};

