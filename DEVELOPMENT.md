# Development Guide

This document explains how to develop, build, and test the Frontier Authentication extension.

## Quick Start

### Development with Auto-reload

For active development with automatic rebuilding and installation:

```bash
npm run dev
```

This command will:

1. Build and package the extension as a VSIX file
2. Automatically detect Codex on your system
3. Install the extension to the Codex extensions directory
4. Watch for file changes and repeat the process automatically

Press `Ctrl+C` to stop the watch mode.

### Manual Build and Install

To build and install the extension once:

```bash
npm run deploy
```

This will build the VSIX package and install it to your Codex installation.

### Build Only

To just create the VSIX package without installing:

```bash
npm run build-vsix
```

This creates a `frontier-authentication-{version}.vsix` file in the project root.

### Install Only

If you already have a VSIX file and want to install it:

```bash
npm run install-extension
```

## Available Scripts

| Script                      | Description                                          |
| --------------------------- | ---------------------------------------------------- |
| `npm run dev`               | Watch mode: auto-rebuild and install on file changes |
| `npm run deploy`            | Build and install the extension once                 |
| `npm run build-vsix`        | Build the VSIX package only                          |
| `npm run install-extension` | Install the latest VSIX package                      |
| `npm run compile`           | Compile TypeScript (development mode)                |
| `npm run package`           | Compile TypeScript (production mode)                 |
| `npm run watch`             | Watch TypeScript files for changes                   |
| `npm run test`              | Run all tests                                        |
| `npm run lint`              | Run ESLint                                           |

## Installation Target

The installation script is designed specifically for **Codex** and will fail if Codex is not found on the system.

### Codex Installation

- **CLI Installation**: Uses `codex --install-extension` if Codex CLI is available
- **Manual Installation**: Extracts to `~/.codex/extensions/` on macOS/Linux or `%APPDATA%/Codex/User/extensions/` on Windows

The script will exit with an error if:

- The `codex` command is not found in PATH, AND
- The Codex extensions directory doesn't exist

This ensures the extension is only installed where it's intended to run.

## File Watching

The `npm run dev` command uses different file watching utilities depending on your system:

1. **fswatch** (macOS) - Install with `brew install fswatch`
2. **inotifywait** (Linux) - Install with `sudo apt-get install inotify-tools`
3. **entr** (Cross-platform) - Install with `brew install entr` or equivalent
4. **Polling fallback** - If no file watcher is available, polls every 5 seconds

## Directory Structure

```
├── src/                          # Source code
├── scripts/                      # Build and deployment scripts
│   ├── install-extension.sh      # Installation script
│   └── watch-and-install.sh      # Watch mode script
├── dist/                         # Compiled output
├── out/                          # Test compilation output
└── *.vsix                        # Generated extension packages
```

## Development Workflow

1. **Start development**: `npm run dev`
2. **Make changes** to TypeScript files in `src/`
3. **Extension rebuilds automatically** and installs to your editor
4. **Restart your editor** to load the updated extension
5. **Test your changes** in VS Code/Codex

## Troubleshooting

### Extension not loading

- Restart your editor after installation
- Check that the extension appears in the Extensions view
- Look for errors in the Developer Console (`Help > Toggle Developer Tools`)

### Build failures

- Run `npm run lint` to check for code issues
- Run `npm run test` to verify all tests pass
- Check that all TypeScript files compile correctly

### Installation issues

- Verify Codex is properly installed
- Check file permissions in the Codex extensions directory (`~/.codex/extensions/`)
- Ensure the `codex` command is in your PATH or the extensions directory exists
- Try manual installation by extracting the VSIX file

### Watch mode not working

- Install a file watching utility (see File Watching section above)
- Check that the `src/` directory exists and contains TypeScript files
- Verify file permissions allow reading the source files

## Testing

Run the full test suite:

```bash
npm run test
```

The tests include:

- Unit tests for individual components
- Integration tests for authentication flows
- Extension activation and command registration tests

## Publishing

When ready to publish a new version:

1. Update the version in `package.json`
2. Update `CHANGELOG.md` with your changes
3. Run `npm run build-vsix` to create the package
4. Test the package with `npm run install-extension`
5. Publish to the VS Code Marketplace or distribute the VSIX file directly
