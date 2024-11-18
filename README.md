# Frontier Authentication Extension

A VS Code extension that provides seamless authentication and GitLab integration for Frontier RND services.

## Features

- **Secure Authentication**: Login and register with Frontier RND services directly from VS Code
- **GitLab Integration**: Create and manage GitLab projects without leaving your editor
- **Real-time Status**: Monitor authentication and server connection status
- **Persistent Sessions**: Maintains your session across VS Code restarts
- **Secure Token Storage**: Uses VS Code's built-in secret storage for credentials

## Installation

1. Download the VSIX file from the releases page
2. Install via VS Code:
   - Open VS Code
   - Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (macOS)
   - Type "Install from VSIX" and select the downloaded file

## Usage

### Authentication

1. Open the Frontier sidebar (View > Show Frontier Sidebar)
2. Choose "Login" or "Register"
3. Fill in your credentials
4. Your authentication status will be displayed in the status bar

### Creating GitLab Projects

1. Ensure you're authenticated
2. Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (macOS)
3. Type "Frontier: Create GitLab Project"
4. Follow the prompts to:
   - Enter project name
   - Add optional description
   - Select visibility (private/internal/public)

### Status Indicators

The extension provides two status indicators:
- **Authentication**: Shows if you're currently logged in
- **Server Connection**: Shows if the Frontier services are reachable

### Commands

```
frontier.login         - Open the login panel
frontier.logout        - Log out of your session
frontier.createGitLabProject - Create a new GitLab project
```

## Development

### Prerequisites

- Node.js 14+
- VS Code
- Git

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/your-org/frontier-authentication
   cd frontier-authentication
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Open in VS Code:
   ```bash
   code .
   ```

### Building

- Press `F5` to start debugging
- Run `npm run compile` to build
- Run `npm run watch` to build with watch mode

### Project Structure

- `src/extension.ts` - Extension entry point
- `src/auth/` - Authentication provider implementation
- `src/webviews/` - Webview UI components
- `src/commands/` - Command implementations

## Security

- All tokens are stored securely using VS Code's secret storage
- Communication with Frontier services uses HTTPS
- Password requirements enforced during registration
- Sanitized GitLab information display

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to your branch
5. Create a Pull Request

## License

[Your License Here]

## Support

For support, please:
1. Check the [issues](https://github.com/your-org/frontier-authentication/issues) page
2. Create a new issue if needed
3. Contact Frontier RND support

## Release Notes

### 1.0.0
- Initial release
- Authentication system
- GitLab project creation
- Status monitoring