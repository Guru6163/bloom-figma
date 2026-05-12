/**
 * @file Webpack UI bundle entry: imports global styles so css-loader + style-loader
 * emit `ui.js`, which HtmlWebpackPlugin inlines into `dist/ui.html`.
 */
import './ui.css'
