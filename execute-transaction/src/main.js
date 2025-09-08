import { Client, Databases, Users, ID } from 'node-appwrite';
import fetch from 'node-fetch';

export default async ({ req, res, log, error }) => {
  // --- Robust Payload Parsing ---
  let payload;
  try {
    if (req.bodyRaw) {
      payload = JSON.parse(req.bodyRaw);
    } else if (process.env.APPWRITE_FUNCTION_EVENT_DATA) {
      payload = JSON.parse(process.env.APPWRITE_FUNCTION_EVENT_DATA);
    } else {
      payload = req.body;
    }
  } catch (e) {
      error('Failed to parse request payload:', e.message);
      return res.json({ success: false, error: 'Invalid request body.' }, 400);
  }

  if (!payload) {
    return res.json({ success: false, error: 'Missing request payload.' }, 400);
  }

  const { type, amount, currency, details } = payload;
  const userId = req.headers['x-appwrite-user-id'];

  // --- Environment Variable Validation ---
  const {
    APPWRITE_API_KEY,
    APPWRITE_CUSTOM_ENDPOINT,
    PAYSTACK_SECRET_KEY,
    DATABASE_ID,
    USERS_COLLECTION_ID,
    SAVINGS_COLLECTION_ID,
    TRANSACTIONS_COLLECTION_ID,
  } = process.env;

  if (
    !APPWRITE_API_KEY ||
    !APPWRITE_CUSTOM_ENDPOINT ||
    !PAYSTACK_SECRET_KEY ||
    !DATABASE_ID ||
    !USERS_COLLECTION_ID ||
    !SAVINGS_COLLECTION_ID ||
    !TRANSACTIONS_COLLECTION_ID
  ) {
    error('Missing one or more required environment variables.');
    return res.json({ success: false, error: 'Server misconfiguration.' }, 500);
  }
  
  if (!userId) {
    error('Could not identify the user. Function was not executed by a logged-in user.');
    return res.json({ success: false, error: 'Authentication failed. Please log in.' }, 401);
  }

  const client = new Client()
    .setEndpoint(APPWRITE_CUSTOM_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(APPWRITE_API_KEY);

  const databases = new Databases(client);
  const users = new Users(client); // --- Initialize the Users service ---
  const paystackBaseUrl = 'https://api.paystack.co';

  try {
    const userDoc = await databases.getDocument(DATABASE_ID, USERS_COLLECTION_ID, userId);
    const balanceField = currency === 'GHS' ? 'balanceGHS' : 'balanceNGN';
    const userBalance = userDoc[balanceField];

    // --- Transaction Logic ---
    switch (type) {
      // --- LIVE VIRTUAL CARD CASES ---
      case 'create-virtual-card': {
        log(`Attempting to create LIVE virtual card for user: ${userId}`);
        
        // --- THE FIX: Get the user's email from the Auth service ---
        const userAuthRecord = await users.get(userId);
        const userEmail = userAuthRecord.email;
        
        // Step 1: Create a Paystack Customer for the user
        const customerResponse = await fetch(`${paystackBaseUrl}/customer`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ 
                email: userEmail, // Use the correct email
                first_name: userDoc.name.split(' ')[0], 
                last_name: userDoc.name.split(' ')[1] || userDoc.name.split(' ')[0] 
            }),
        });
        const customerData = await customerResponse.json();
        if (!customerData.status) {
            throw new Error(`Paystack customer creation failed: ${customerData.message}`);
        }
        const customerCode = customerData.data.customer_code;
        
        // Step 2: Create the Virtual Card linked to the customer
        const cardResponse = await fetch(`${paystackBaseUrl}/virtual_card`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                customer: customerCode,
                currency: currency,
            }),
        });
        
        const cardData = await cardResponse.json();
        if (!cardData.status) {
            throw new Error(`Paystack card creation failed: ${cardData.message}`);
        }
        
        const liveCard = cardData.data;
        const newCard = {
            id: liveCard.id,
            cardNumber: liveCard.card_pan,
            cvv: liveCard.cvv,
            expiryMonth: liveCard.expiry_month,
            expiryYear: liveCard.expiry_year,
            currency: liveCard.currency,
            balance: 0.0,
            isActive: true,
        };
        
        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, {
            virtualCard: JSON.stringify(newCard),
        });
        
        log('LIVE Virtual card created successfully for user:', userId);
        return res.json({ success: true, data: newCard });
      }
      
      case 'fund-virtual-card': {
        if (userBalance < amount) {
          throw new Error('Insufficient wallet balance.');
        }

        const card = JSON.parse(userDoc.virtualCard);

        // Step 1: LIVE API call to Paystack to fund the card
        const fundResponse = await fetch(`${paystackBaseUrl}/virtual_card/${card.id}/fund`, {
          method: 'POST',
          headers: {
              Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
              'Content-Type': 'application/json',
          },
          body: JSON.stringify({
              amount: amount * 100, // Paystack expects amount in kobo/pesewas
              from: "balance" // Fund from your Paystack balance
          }),
        });

        const fundData = await fundResponse.json();
        if (!fundData.status) {
            throw new Error(`Paystack card funding failed: ${fundData.message}`);
        }

        // Step 2: Update internal balances
        const newCardBalance = card.balance + amount;
        const newUserBalance = userBalance - amount;
        card.balance = newCardBalance;
        
        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, {
            [balanceField]: newUserBalance,
            virtualCard: JSON.stringify(card),
        });

        await databases.createDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, ID.unique(), {
            userId: userId, type: 'debit', amount: amount, description: 'Virtual Card Funding', status: 'Completed',
        });

        log(`Successfully funded LIVE virtual card for user ${userId}`);
        return res.json({ success: true, message: 'Card funded successfully' });
      }

      case 'freeze-virtual-card':
      case 'unfreeze-virtual-card': {
          const card = JSON.parse(userDoc.virtualCard);
          const endpoint = type === 'freeze-virtual-card' ? 'freeze' : 'unfreeze';

          // LIVE API call to Paystack to change card status
          const statusResponse = await fetch(`${paystackBaseUrl}/virtual_card/${card.id}/${endpoint}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
            },
          });
          const statusData = await statusResponse.json();
          if(!statusData.status){
             throw new Error(`Paystack card ${endpoint} failed: ${statusData.message}`);
          }

          // Update internal status
          card.isActive = type === 'unfreeze-virtual-card'; 
          await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, {
              virtualCard: JSON.stringify(card),
          });
          
          log(`LIVE Card ${type} successful for user:`, userId);
          return res.json({ success: true, message: `Card ${endpoint} successful.` });
      }

      // --- EXISTING TRANSACTION CASES ---
      case 'p2p-transfer': {
        const { recipientId } = details;
        if (userBalance < amount) throw new Error('Insufficient balance.');
        
        const newSenderBalance = userBalance - amount;
        const recipientDoc = await databases.getDocument(DATABASE_ID, USERS_COLLECTION_ID, recipientId);
        const newRecipientBalance = recipientDoc[balanceField] + amount;

        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, { [balanceField]: newSenderBalance });
        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, recipientId, { [balanceField]: newRecipientBalance });

        await databases.createDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, ID.unique(), {
            userId: userId, type: 'debit', amount: amount, description: `Transfer to ${recipientDoc.name}`, status: 'Completed',
        });
        await databases.createDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, ID.unique(), {
            userId: recipientId, type: 'credit', amount: amount, description: `Transfer from ${userDoc.name}`, status: 'Completed',
        });

        return res.json({ success: true, message: 'Transfer successful' });
      }

      case 'pay-bill': {
        const { biller } = details;
         if (userBalance < amount) throw new Error('Insufficient balance.');
        
        const newBalance = userBalance - amount;
        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, { [balanceField]: newBalance });

        await databases.createDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, ID.unique(), {
            userId: userId, type: 'debit', amount: amount, description: `Bill payment: ${biller}`, status: 'Completed',
        });

        return res.json({ success: true, message: 'Bill payment successful' });
      }
      
      case 'fund-susu': {
        const { planId } = details;
        if (userBalance < amount) throw new Error('Insufficient balance.');
        
        const newWalletBalance = userBalance - amount;
        const planDoc = await databases.getDocument(DATABASE_ID, SAVINGS_COLLECTION_ID, planId);
        const newPlanBalance = planDoc.currentBalance + amount;

        await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, userId, { [balanceField]: newWalletBalance });
        await databases.updateDocument(DATABASE_ID, SAVINGS_COLLECTION_ID, planId, { currentBalance: newPlanBalance });
        
        await databases.createDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, ID.unique(), {
            userId: userId, type: 'debit', amount: amount, description: `Savings contribution: ${planDoc.planName}`, status: 'Completed',
        });

        return res.json({ success: true, message: 'Savings plan funded successfully' });
      }

      default:
        throw new Error('Invalid transaction type.');
    }
  } catch (e) {
    error('Transaction failed:', e.message);
    return res.json({ success: false, error: `Transaction failed: ${e.message}` }, 400);
  }
};

