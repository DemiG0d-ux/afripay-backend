import { Client, Databases, Query } from 'node-appwrite';

const client = new Client();
const databases = new Databases(client);

client
  .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT)
  .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);

export default async ({ req, res, log, error }) => {
  try {
    const { email } = req.body || {};
    
    if (!email) {
      return res.json({ 
        success: false, 
        error: 'Email is required' 
      }, 400);
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.json({ 
        success: false, 
        error: 'Invalid email format' 
      }, 400);
    }

    log('Searching for user with email: ' + email);

    const result = await databases.listDocuments(
      process.env.DATABASE_ID,
      process.env.USERS_COLLECTION_ID,
      [
        Query.equal('email', email.toLowerCase().trim()),
        Query.limit(1)
      ]
    );

    if (result.documents && result.documents.length > 0) {
      const user = result.documents[0];
      return res.json({
        success: true,
        user: {
          id: user.$id,
          email: user.email,
          name: user.name,
          country: user.country,
          balanceGHS: user.balanceGHS,
          balanceNGN: user.balanceNGN
        }
      });
    } else {
      return res.json({
        success: true,
        user: null,
        message: 'User not found'
      });
    }

  } catch (err) {
    error('Function error: ' + err.message);
    return res.json({
      success: false,
      error: 'Something went wrong'
    }, 500);
  }
};