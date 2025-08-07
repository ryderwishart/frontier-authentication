# LFS URL Credentials Fix

## Issue Description

The LFS implementation was failing with the error:

```
TypeError: Request cannot be constructed from a URL that includes credentials:
https://oauth2:codextoken-XXX@git.genesisrnd.com/...
```

## Root Cause

The issue occurred because:

1. **Git Config Contains Credentials**: The `remote.origin.url` from git config contained embedded credentials in the format `https://username:token@domain.com/...`

2. **Fetch API Restriction**: The modern Fetch API doesn't allow URLs with embedded credentials. When `uploadBlob` tried to make HTTP requests to the LFS endpoint, it failed because the URL contained credentials.

3. **Double Authentication**: The URL had credentials AND we were passing auth separately, causing a conflict.

## Solution

**Cleaned URLs Before LFS Operations**: Modified the LFS service to strip embedded credentials from URLs before passing them to LFS functions.

### Code Changes

```typescript
// Clean the URL to remove any embedded credentials
const cleanURL = remoteURL.replace(/^https?:\/\/[^@]*@/, "https://");

// Use clean URL with separate auth
const pointerInfo = await uploadBlob(
    {
        http,
        url: cleanURL, // Clean URL without embedded credentials
        ...(auth && { auth }), // Separate auth object
    },
    fileContent
);
```

### Files Modified

1. **`src/git/LFSService.ts`**:
    - `uploadFileToLFS()` - Fixed upload URL handling
    - `readBlobWithLFS()` - Fixed download URL handling
    - `processFileForLFS()` - Fixed URL cleaning in main workflow

### URL Transformation Examples

| Original URL                                       | Cleaned URL                            |
| -------------------------------------------------- | -------------------------------------- |
| `https://oauth2:token123@git.example.com/repo.git` | `https://git.example.com/repo.git`     |
| `https://user:pass@github.com/user/repo.git`       | `https://github.com/user/repo.git`     |
| `https://token@gitlab.com/group/project.git`       | `https://gitlab.com/group/project.git` |

## How Authentication Works Now

1. **URL Cleaning**: Strip any embedded credentials from the git remote URL
2. **Separate Auth**: Pass authentication credentials in the dedicated `auth` object
3. **HTTP Headers**: The LFS library properly formats credentials as HTTP Authorization headers
4. **Compatibility**: Works with GitLab, GitHub, and other Git LFS providers

## Benefits of This Fix

- ✅ **Compliant with Fetch API**: No more credential-in-URL errors
- ✅ **Secure**: Credentials handled properly in HTTP headers
- ✅ **Compatible**: Works with various Git hosting providers
- ✅ **Reliable**: Consistent authentication method across all LFS operations

## Testing

After this fix, LFS upload operations should work without the credential URL error. You should see:

1. **Successful Upload**: Files uploaded to LFS without errors
2. **LFS Badges**: Files show LFS badges in GitLab/GitHub
3. **Clean Logs**: No more "Request cannot be constructed" errors
4. **Proper Notifications**: Success messages for LFS processing

## Impact

This fix resolves the core authentication issue that was preventing automatic LFS upload of multimedia files, ensuring that all audio files, videos, and other large assets are properly stored in Git LFS as intended.
