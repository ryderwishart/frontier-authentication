# Integration Guide: Conflict-Free metadata.json Management

## Overview

This guide explains how to integrate the MetadataManager system across both `frontier-authentication` and `codex-editor` extensions to prevent conflicts and data loss when modifying `metadata.json` files.

## Problem Statement

Both extensions currently modify `metadata.json` without coordination, leading to:
- **Race conditions** during concurrent updates
- **Data loss** when one extension overwrites another's changes
- **Corrupted files** during simultaneous writes
- **Inconsistent state** across the ecosystem

## Solution Architecture

### 🏗️ MetadataManager System

The MetadataManager provides:
- **Exclusive file locking** to prevent concurrent writes
- **Atomic operations** with backup and rollback
- **Retry mechanisms** with exponential backoff
- **Stale lock detection** and cleanup
- **JSON validation** and structure preservation

### 📁 Recommended File Structure

```
metadata.json
{
  "meta": {
    "requiredExtensions": {
      "codexEditor": "1.2.3",
      "frontierAuthentication": "2.1.0"
    },
    "codexEditor": {
      // Codex Editor specific metadata
      "lastSync": "2023-10-01T10:00:00Z",
      "projectSettings": { ... }
    },
    "frontierAuthentication": {
      // Frontier Auth specific metadata  
      "authConfig": { ... },
      "syncSettings": { ... }
    }
  },
  // Shared project metadata
  "projectInfo": { ... },
  "dependencies": { ... }
}
```

## Integration Steps

### Step 1: Copy MetadataManager to Codex Editor

Copy these files from `frontier-authentication` to `codex-editor`:

```
src/utils/metadataManager.ts
src/utils/README-MetadataManager.md
src/test/unit/metadataManager.test.ts
```

### Step 2: Update Package Dependencies

Ensure both extensions have compatible dependencies in `package.json`:

```json
{
  "engines": {
    "vscode": "^1.74.0"
  }
}
```

### Step 3: Replace Direct File Access

#### Before (Unsafe)
```typescript
// ❌ DON'T DO THIS
const metadataPath = vscode.Uri.joinPath(workspaceUri, "metadata.json");
const content = await vscode.workspace.fs.readFile(metadataPath);
const metadata = JSON.parse(new TextDecoder().decode(content));

// Modify metadata
metadata.meta.codexEditor = { lastSync: new Date().toISOString() };

// Write back
await vscode.workspace.fs.writeFile(metadataPath, 
  new TextEncoder().encode(JSON.stringify(metadata, null, 4)));
```

#### After (Safe)
```typescript
// ✅ DO THIS INSTEAD
import { MetadataManager } from './utils/metadataManager';

const result = await MetadataManager.safeUpdateMetadata(
  workspaceUri,
  (metadata) => {
    if (!metadata.meta) metadata.meta = {};
    if (!metadata.meta.codexEditor) metadata.meta.codexEditor = {};
    
    metadata.meta.codexEditor.lastSync = new Date().toISOString();
    return metadata;
  }
);

if (!result.success) {
  console.error('Failed to update metadata:', result.error);
}
```

### Step 4: Extension Version Management

Both extensions should use the standardized version update method:

```typescript
// Update extension versions
const result = await MetadataManager.updateExtensionVersions(workspaceUri, {
  codexEditor: getCurrentExtensionVersion("project-accelerate.codex-editor-extension"),
  frontierAuthentication: getCurrentExtensionVersion("frontier-rnd.frontier-authentication")
});
```

### Step 5: Add Error Handling

Implement proper error handling for all metadata operations:

```typescript
const result = await MetadataManager.safeUpdateMetadata(workspaceUri, updateFunction);

if (!result.success) {
  // Log error for debugging
  console.error(`[${extensionName}] Metadata update failed:`, result.error);
  
  // Show user notification for critical errors
  if (result.error.includes('lock')) {
    vscode.window.showWarningMessage(
      'Another extension is currently updating project metadata. Please try again.'
    );
  } else {
    vscode.window.showErrorMessage(
      'Failed to update project metadata. Check the output panel for details.'
    );
  }
  
  return; // Don't proceed if metadata update failed
}
```

## Migration Checklist

### For Codex Editor Team

- [ ] Copy MetadataManager files to codex-editor project
- [ ] Update all direct `metadata.json` file access to use MetadataManager
- [ ] Add error handling for metadata operations
- [ ] Update extension version management
- [ ] Run integration tests with frontier-authentication
- [ ] Update documentation and team guidelines

### For Frontier Authentication Team

- [ ] ✅ MetadataManager implemented and tested
- [ ] ✅ Extension version checker updated
- [ ] ✅ Comprehensive test suite created
- [ ] Share integration guide with codex-editor team
- [ ] Coordinate deployment timeline
- [ ] Monitor for conflicts during transition period

## Testing Strategy

### Unit Tests
Both extensions should include:
- Basic CRUD operations
- Concurrent access scenarios
- Error handling and recovery
- Performance benchmarks

### Integration Tests
Cross-extension testing:
- Simultaneous updates from both extensions
- Lock timeout and stale lock scenarios
- Complex metadata structure preservation
- Version compatibility checks

### Manual Testing
- Install both extensions in same workspace
- Trigger metadata updates from both extensions simultaneously
- Verify no data loss or corruption
- Check lock file cleanup

## Deployment Coordination

### Phase 1: Preparation
1. Both teams implement MetadataManager
2. Run individual extension tests
3. Coordinate testing timeline

### Phase 2: Integration Testing
1. Test both extensions together in isolated environment
2. Verify conflict resolution works correctly
3. Performance testing under load

### Phase 3: Gradual Rollout
1. Deploy to internal testing environments
2. Monitor for conflicts and issues
3. Full production deployment

### Phase 4: Monitoring
1. Add telemetry for metadata operations
2. Monitor error rates and performance
3. Gather user feedback

## Configuration Options

### Lock Timeout Settings
Adjust based on extension complexity:

```typescript
// For simple updates (default)
const options = {
  retryCount: 5,
  retryDelayMs: 100,
  timeoutMs: 30000
};

// For complex operations
const options = {
  retryCount: 10,
  retryDelayMs: 200,
  timeoutMs: 60000
};
```

### Debug Mode
Enable for troubleshooting:

```typescript
// In metadataManager.ts
const DEBUG_MODE = true; // Enable detailed logging
```

## Troubleshooting

### Common Issues

#### "Failed to acquire metadata lock"
- **Cause**: Another extension is updating metadata
- **Solution**: Automatic retry with backoff (usually resolves itself)
- **Manual Fix**: Check for stale `.metadata.lock` files

#### "Invalid JSON in metadata.json"
- **Cause**: File corruption or incomplete write
- **Solution**: MetadataManager will attempt to restore from backup
- **Manual Fix**: Restore from git history if backup fails

#### "Atomic write failed"
- **Cause**: Filesystem permissions or disk space issues
- **Solution**: Check workspace permissions and available disk space

### Debug Information

Enable debug logging to see:
- Lock acquisition/release timing
- Retry attempts and backoff delays
- File operation details
- Error stack traces

### Support Channels

- **Technical Issues**: Create issue in respective extension repositories
- **Integration Questions**: Contact both extension teams
- **Performance Concerns**: Share telemetry data with teams

## Future Enhancements

### Planned Improvements
1. **Centralized Metadata Service**: Single service managing all metadata operations
2. **Event-Driven Updates**: Notify extensions of metadata changes
3. **Schema Validation**: Enforce metadata structure consistency
4. **Conflict Resolution UI**: User interface for resolving conflicts manually
5. **Metadata Versioning**: Track metadata changes over time

### Extension Points
The MetadataManager is designed to be extensible:
- Custom update functions for complex operations
- Pluggable conflict resolution strategies
- Configurable retry policies
- Custom validation rules

## Conclusion

By adopting the MetadataManager system across both extensions, we can:
- ✅ **Eliminate conflicts** between extensions
- ✅ **Prevent data loss** during concurrent operations
- ✅ **Ensure consistency** across the ecosystem
- ✅ **Improve reliability** of metadata operations
- ✅ **Provide better error handling** for users

The investment in this coordination system will pay dividends in reduced support issues, improved user experience, and more reliable extension interactions.

---

**Next Steps**: Share this guide with the codex-editor team and coordinate implementation timeline.
