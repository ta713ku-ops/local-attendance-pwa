import type { Configuration } from 'webpack';

const config: Configuration = {
  devtool: 'source-map',
  module: {
    rules: [
      { test: /\.tsx?$/, exclude: /node_modules/, use: 'ts-loader' },
      { test: /\.css$/, use: ['style-loader', 'css-loader'] },
    ],
  },
  resolve: { extensions: ['.ts', '.tsx', '.js'] },
  target: 'web',
};
export default config;
