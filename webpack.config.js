//@ts-check

"use strict";

const path = require("path");

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const config = {
    target: "node",
    mode: "none",

    entry: "./src/extension.ts",
    output: {
        path: path.resolve(__dirname, "dist"),
        filename: "extension.js",
        libraryTarget: "commonjs2",
    },
    externals: {
        vscode: "commonjs vscode",
        // Don't bundle these Node.js native modules
        "utf-8-validate": "commonjs utf-8-validate",
        bufferutil: "commonjs bufferutil",
    },
    resolve: {
        extensions: [".ts", ".js"],
        fallback: {
            fs: require.resolve("memfs"),
            path: require.resolve("path-browserify"),
            crypto: require.resolve("crypto-browserify"),
        },
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: [
                    {
                        loader: "ts-loader",
                    },
                ],
            },
        ],
    },
    experiments: {
        asyncWebAssembly: true,
    },
    ignoreWarnings: [/Critical dependency/],
    devtool: "nosources-source-map",
    infrastructureLogging: {
        level: "log",
    },
};

module.exports = config;
