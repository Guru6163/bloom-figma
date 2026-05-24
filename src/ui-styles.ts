/**
 * @file Webpack UI bundle entry.
 * Imports styles (inlined by style-loader) and the application bootstrap.
 * HtmlWebpackPlugin + HtmlInlineScriptPlugin inline the compiled bundle into <head>,
 * so we must defer init() until the DOM is fully parsed.
 */
import './ui.css';
import { init } from './ui/app';

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  // Already parsed (e.g. script moved to body in future)
  init();
}
