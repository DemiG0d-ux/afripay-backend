        import { Client, Users, Query } from 'node-appwrite';

        export default async ({ req, res, log, error }) => {
          try {
            const { name } = JSON.parse(req.payload);
            if (!name) {
              throw new Error("Name is required in the payload.");
            }

            const client = new Client()
              .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT)
              .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
              .setKey(process.env.APPWRITE_API_KEY);

            const users = new Users(client);

            // Use the server-side SDK to search for a user by name
            const userList = await users.list([
              Query.search('name', name) // Using a search query for flexibility
            ]);

            if (userList.total === 0) {
              return res.json({ success: false, message: 'User not found.' });
            }

            // Return a list of potential matches (public info only)
            const foundUsers = userList.users.map(user => ({
              id: user.$id,
              name: user.name,
              email: user.email // Also return email for confirmation in the app
            }));

            return res.json({
              success: true,
              data: foundUsers,
            });

          } catch (err) {
            error(`Function failed: ${err.message}`);
            return res.json({ success: false, message: err.message }, 500);
          }
        };
        