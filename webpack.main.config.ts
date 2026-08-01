import type { Configuration } from 'webpack';

const config: Configuration = {
  entry: './src/main/index.ts',
  externals: {
    'better-sqlite3': 'commonjs better-sqlite3',
  },
  module: {
    rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: 'ts-loader' }],
  },
  resolve: { extensions: ['.ts', '.tsx', '.js'] },
  target: 'electron-main',
};
export default config;
