Authentication Extension Implementation Plan:

✅ 1. Basic Extension Setup

- Create extension scaffolding with `yo code`
- Configure package.json with authentication-related commands
- Set up webpack for bundling (since we'll use node modules)

⏳ 2. Authentication State Management

- Implement SecretStorage for token storage
- Create authentication context/state manager
- Add logout capability

⏳ 3. Authentication Commands

- Register command: Opens webview for registration
- Login command: Opens webview for login
- Logout command: Clears credentials
- Status command: Shows current auth state

⏳ 4. UI Components

- Registration webview form
- Login webview form
- Status bar item showing auth state
- Progress notifications

⏳ 5. API Integration

- Create API client for auth endpoints
- Implement registration flow
- Implement login flow
- Handle token refresh/expiry

⏳ 6. Error Handling & UX

- Proper error messages for all failure cases
- Loading states during auth operations
- Token validation
- Network error handling

⏳ 7. Security Considerations

- Secure token storage using SecretStorage
- HTTPS validation
- Input validation
- Clear sensitive data on logout
