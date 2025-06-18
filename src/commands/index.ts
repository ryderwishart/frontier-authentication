import * as vscode from "vscode";
import { FrontierAuthProvider } from "../auth/AuthenticationProvider";
import { GitLabService } from "../gitlab/GitLabService";
import { GitService } from "../git/GitService";

export async function loginWithCredentials(
    authProvider: FrontierAuthProvider,
    username: string,
    password: string
): Promise<boolean> {
    try {
        return await authProvider.login(username, password);
    } catch (error) {
        console.error("Login error:", error);
        return false;
    }
}

export async function registerUser(
    authProvider: FrontierAuthProvider,
    username: string,
    email: string,
    password: string
): Promise<boolean> {
    try {
        await authProvider.register(username, email, password);
        return true;
    } catch (error) {
        if (error instanceof Error) {
            vscode.window.showErrorMessage(`Registration failed: ${error.message}`);
            return false;
        } else {
            vscode.window.showErrorMessage("Registration failed. Please try again.");
            return false;
        }
    }
}

export function registerCommands(
    context: vscode.ExtensionContext,
    authProvider: FrontierAuthProvider,
    gitService?: GitService // Add gitService parameter to allow debug logging control
) {
    context.subscriptions.push(
        // Register login command with input handling
        vscode.commands.registerCommand(
            "frontier.login",
            async (username?: string, password?: string) => {
                try {
                    // If credentials are provided, use them directly
                    if (username && password) {
                        const success = await loginWithCredentials(
                            authProvider,
                            username,
                            password
                        );
                        if (success) {
                            vscode.window.showInformationMessage("Successfully logged in");
                        } else {
                            vscode.window.showErrorMessage(
                                "Login failed. Please check your credentials and try again."
                            );
                        }
                        return success;
                    }

                    // Otherwise, prompt for credentials
                    const usernameInput = await vscode.window.showInputBox({
                        prompt: "Enter your username",
                        placeHolder: "Username",
                    });

                    if (!usernameInput) {
                        return false;
                    }

                    const passwordInput = await vscode.window.showInputBox({
                        prompt: "Enter your password",
                        password: true,
                        placeHolder: "Password",
                    });

                    if (!passwordInput) {
                        return false;
                    }

                    const success = await loginWithCredentials(
                        authProvider,
                        usernameInput,
                        passwordInput
                    );
                    if (success) {
                        vscode.window.showInformationMessage("Successfully logged in");
                    } else {
                        vscode.window.showErrorMessage(
                            "Login failed. Please check your credentials and try again."
                        );
                    }
                    return success;
                } catch (error) {
                    vscode.window.showErrorMessage(
                        "An error occurred during login. Please try again."
                    );
                    console.error("Login error:", error);
                    return false;
                }
            }
        ),

        // Register registration command
        vscode.commands.registerCommand(
            "frontier.register",
            async (username?: string, email?: string, password?: string) => {
                try {
                    // If all credentials are provided, use them directly
                    if (username && email && password) {
                        const success = await registerUser(authProvider, username, email, password);
                        if (success) {
                            vscode.window.showInformationMessage("Successfully registered");
                        } else {
                            vscode.window.showErrorMessage(
                                "Registration failed. Please try again."
                            );
                        }
                        return success;
                    }

                    // Otherwise, prompt for credentials
                    const usernameInput = await vscode.window.showInputBox({
                        prompt: "Enter your username",
                        placeHolder: "Username",
                    });

                    if (!usernameInput) {
                        return false;
                    }

                    const emailInput = await vscode.window.showInputBox({
                        prompt: "Enter your email",
                        placeHolder: "Email",
                    });

                    if (!emailInput) {
                        return false;
                    }

                    const passwordInput = await vscode.window.showInputBox({
                        prompt: "Enter your password",
                        password: true,
                        placeHolder: "Password",
                    });

                    if (!passwordInput) {
                        return false;
                    }

                    const success = await registerUser(
                        authProvider,
                        usernameInput,
                        emailInput,
                        passwordInput
                    );
                    if (success) {
                        vscode.window.showInformationMessage("Successfully registered");
                    } else {
                        vscode.window.showErrorMessage("Registration failed. Please try again.");
                    }
                    return success;
                } catch (error) {
                    vscode.window.showErrorMessage(
                        "An error occurred during registration. Please try again."
                    );
                    console.error("Registration error:", error);
                    return false;
                }
            }
        ),

        // Register logout command
        vscode.commands.registerCommand("frontier.logout", async () => {
            const choice = await vscode.window.showWarningMessage(
                "Are you sure you want to log out?",
                { modal: true },
                "Log Out",
                "Cancel"
            );

            if (choice === "Log Out") {
                await authProvider.logout();
                vscode.window.showInformationMessage("Successfully logged out");
                return true;
            }
            return false;
        }),

        // Get auth status command
        vscode.commands.registerCommand("frontier.getAuthStatus", () => {
            return authProvider.getAuthStatus();
        }),

        // Add getUserInfo command
        vscode.commands.registerCommand("frontier.getUserInfo", async () => {
            try {
                const gitLabService = new GitLabService(authProvider);
                await gitLabService.initializeWithRetry();
                return gitLabService.getUserInfo();
            } catch (error) {
                console.error("Error getting user info:", error);
                vscode.window.showErrorMessage(
                    "Failed to get user info. Please check your authentication status."
                );
                return { email: "", username: "" };
            }
        }),

        // Add debug logging toggle command
        vscode.commands.registerCommand("frontier.toggleDebugLogging", async () => {
            if (!gitService) {
                vscode.window.showErrorMessage("Git service not available");
                return;
            }

            const config = vscode.workspace.getConfiguration('frontier');
            const currentSetting = config.get<boolean>('debugGitLogging', false);
            const newSetting = !currentSetting;
            
            await config.update('debugGitLogging', newSetting, vscode.ConfigurationTarget.Global);
            gitService.setDebugLogging(newSetting);
            
            const status = newSetting ? "enabled" : "disabled";
            vscode.window.showInformationMessage(`Debug logging ${status}`);
            
            return newSetting;
        })
    );
}
