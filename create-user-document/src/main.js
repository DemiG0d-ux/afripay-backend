import { Client, Databases, Permission, Role } from 'node-appwrite';

export default async ({ req, res, log, error }) => {
  try {
    // Initialize Appwrite client
    const client = new Client()
      .setEndpoint(process.env.APPWRITE_CUSTOM_ENDPOINT) 
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_API_KEY);
    
    const databases = new Databases(client);
    
    // Validate environment variables
    if (!process.env.APPWRITE_FUNCTION_EVENT_DATA) {
      throw new Error('No event data received');
    }
    
    // Parse user data from event
    const user = JSON.parse(process.env.APPWRITE_FUNCTION_EVENT_DATA);
    
    // Validate user data
    if (!user || !user.$id || !user.name) {
      throw new Error('Invalid user data: missing required fields ($id or name)');
    }
    
    log(`Processing user creation for ${user.$id} (${user.name})`);
    
    // Configuration with defaults
    const databaseId = process.env.DATABASE_ID || '686ac6ae001f516e943e';
    const usersCollectionId = process.env.USERS_COLLECTION_ID || '686acc5e00101633025d';
    const defaultCountry = process.env.DEFAULT_COUNTRY || 'ghana';
    const defaultBalanceGHS = parseFloat(process.env.DEFAULT_BALANCE_GHS) || 0.0;
    const defaultBalanceNGN = parseFloat(process.env.DEFAULT_BALANCE_NGN) || 0.0;
    
    // Prepare user document data
    const userData = {
      'name': user.name,
      'email': user.email || '', // Include email if available
      'country': defaultCountry,
      'balanceGHS': defaultBalanceGHS,
      'balanceNGN': defaultBalanceNGN,
      'createdAt': new Date().toISOString(),
      'updatedAt': new Date().toISOString()
    };
    
    // Set up permissions - only the user can read and update their own document
    const permissions = [
      Permission.read(Role.user(user.$id)),
      Permission.update(Role.user(user.$id)),
      Permission.delete(Role.user(user.$id)) // Optional: allow user to delete their own document
    ];
    
    try {
      // Create the user document
      const document = await databases.createDocument(
        databaseId,
        usersCollectionId,
        user.$id, // Use user ID as document ID
        userData,
        permissions
      );
      
      log(`Successfully created database document for user ${user.name} (${user.$id})`);
      
      return res.json({ 
        success: true, 
        message: 'User document created successfully',
        documentId: document.$id
      });
      
    } catch (createError) {
      // Handle duplicate document creation (409 Conflict)
      if (createError.code === 409 || createError.message.includes('already exists')) {
        log(`Document already exists for user ${user.$id} (${user.name})`);
        return res.json({ 
          success: true, 
          message: 'User document already exists',
          documentId: user.$id 
        });
      }
      
      // Handle other database errors
      throw new Error(`Database operation failed: ${createError.message}`);
    }
    
  } catch (err) {
    const errorMessage = `Failed to create user document: ${err.message}`;
    error(errorMessage);
    
    // Log additional error details for debugging
    if (err.stack) {
      error(`Error stack: ${err.stack}`);
    }
    
    return res.json({ 
      success: false, 
      message: err.message,
      error: 'USER_DOCUMENT_CREATION_FAILED'
    }, 400);
  }
};