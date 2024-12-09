import * as assert from 'assert';
import * as vscode from 'vscode';
import { activateExtension, assertCommandExists, clearAuthenticationState } from '../../helpers/testHelper';

suite('Extension Test Suite', () => {
    vscode.window.showInformationMessage('Starting extension tests.');

    test('Extension should be present', async () => {
        const ext = vscode.extensions.getExtension('frontier-rnd.frontier-authentication');
        assert.ok(ext);
    });

    test('Extension should activate', async () => {
        const { ext, api } = await activateExtension();
        assert.ok(ext.isActive);
    });

    test('All commands should be registered', async () => {
        const commands = [
            'frontier.login',
            'frontier.register',
            'frontier.logout',
            'frontier.getAuthStatus',
            'frontier.listProjects',
            'frontier.cloneRepository',
            'frontier.createGitLabProject',
            'frontier.createAndCloneProject',
            'frontier.syncChanges',
            'frontier.toggleAutoSync',
            'frontier.confirmLogout',
            'frontier.publishWorkspace',
            'frontier.getUserInfo',
            'frontier.listGroupsUserIsAtLeastMemberOf'
        ];

        commands.forEach(cmd => {
            assertCommandExists(cmd);
        });
    });

    test('Authentication provider should be registered', async () => {
        const authProvider = vscode.authentication.getSession('frontier', []);
        assert.ok(authProvider instanceof Promise);
    });

    suiteTeardown(async () => {
        await clearAuthenticationState();
    });
}); 