import { Client, Users, Query } from 'node-appwrite';

// This function securely finds a user by their email address.
export default async ({ req, res, log, error }) => {
  try {
    // Input validation
    const { email } = req.body;
    
    if (!email) {
      return res.json({ 
        success: false, 
        message: 'Email is required.' 
      }, 400);
    }

    // Basic email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.json({ 
        success: false, 
        message: 'Invalid email format.' 
      }, 400);
    }

    // Normalize email (trim whitespace and convert to lowercase)
    const normalizedEmail = email.trim().toLowerCase();

    // Initialize Appwrite client
    const client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_API_KEY);

    const users = new Users(client);

    log(`Searching for user with email: ${normalizedEmail}`);

    // Search for user by email
    const userList = await users.list([
      Query.equal('email', normalizedEmail)
    ]);

    if (userList.total === 0) {
      log(`No user found with email: ${normalizedEmail}`);
      return res.json({ 
        success: false, 
        message: 'User not found.' 
      }, 404);
    }

    const foundUser = userList.users[0];
    
    log(`User found: ${foundUser.$id}`);

    // Return only safe, public information
    return res.json({
      success: true,
      data: {
        id: foundUser.$id,
        name: foundUser.name,
        email: foundUser.email, // Email is already known by the caller
        emailVerification: foundUser.emailVerification,
        status: foundUser.status,
        registration: foundUser.registration,
        // Add other safe fields as needed
        // prefs: foundUser.prefs, // Only if you want to expose user preferences
      },
    });

  } catch (err) {
    // Log the full error for debugging
    error(`Function failed: ${err.message}`, { 
      stack: err.stack,
      email: req.body?.email 
    });

    // Return generic error message to client
    return res.json({ 
      success: false, 
      message: 'An error occurred while searching for the user.' 
    }, 500);
  }
};