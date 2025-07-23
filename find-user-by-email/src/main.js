import { Client, Databases, Query } from 'node-appwrite';

// Initialize client and databases outside the function for reuse
let client = null;
let databases = null;

const initializeAppwrite = () => {
  if (!client) {
    client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_API_KEY);
    
    databases = new Databases(client);
  }
  return { client, databases };
};

export default async ({ req, res, log, error }) => {
  const startTime = Date.now();
  
  try {
    // Log function start
    log(`Function started at ${new Date().toISOString()}`);
    
    // Initialize Appwrite services (cached after first run)
    const { databases: db } = initializeAppwrite();
    log(`Appwrite initialized in ${Date.now() - startTime}ms`);
    
    // Validate request body
    const { email } = req.body || {};
    
    if (!email) {
      log('Error: Email is required');
      return res.json({ 
        success: false, 
        error: 'Email is required' 
      }, 400);
    }
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      log('Error: Invalid email format');
      return res.json({ 
        success: false, 
        error: 'Invalid email format' 
      }, 400);
    }
    
    const cleanEmail = email.toLowerCase().trim();
    log(`Searching for user with email: ${cleanEmail}`);
    
    const dbStartTime = Date.now();
    
    // Add timeout wrapper for database query
    const queryPromise = db.listDocuments(
      process.env.DATABASE_ID,
      process.env.USERS_COLLECTION_ID,
      [
        Query.equal('email', cleanEmail),
        Query.limit(1)
      ]
    );
    
    // Implement query timeout (20 seconds)
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Database query timeout')), 20000)
    );
    
    const result = await Promise.race([queryPromise, timeoutPromise]);
    
    log(`Database query completed in ${Date.now() - dbStartTime}ms`);
    
    if (result.documents && result.documents.length > 0) {
      const user = result.documents[0];
      log(`User found: ${user.$id}`);
      
      const response = {
        success: true,
        user: {
          id: user.$id,
          email: user.email,
          name: user.name,
          country: user.country,
          balanceGHS: user.balanceGHS,
          balanceNGN: user.balanceNGN
        }
      };
      
      log(`Function completed successfully in ${Date.now() - startTime}ms`);
      return res.json(response);
    } else {
      log('User not found');
      const response = {
        success: true,
        user: null,
        message: 'User not found'
      };
      
      log(`Function completed in ${Date.now() - startTime}ms`);
      return res.json(response);
    }
    
  } catch (err) {
    const executionTime = Date.now() - startTime;
    error(`Function failed after ${executionTime}ms: ${err.message}`);
    
    // Log stack trace for debugging
    if (err.stack) {
      error(`Stack trace: ${err.stack}`);
    }
    
    return res.json({
      success: false,
      error: 'Something went wrong',
      ...(process.env.NODE_ENV === 'development' && { details: err.message })
    }, 500);
  }
};