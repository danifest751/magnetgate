;(function (root) {
  // the placeholder follows the UI language (required in Node, loaded before this file in the window)
  const I18n = typeof module !== 'undefined' && module.exports ? require('./i18n.js') : root.MGI18n
  function diagnosticText(value) {
    const hidden = I18n ? I18n.t('privacy.hidden') : '[address hidden]'
    return String(value ?? '')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, hidden)
      .replace(/(?:[a-f\d]{0,4}:){2,}[a-f\d:.]*/gi, value =>
        value.includes('::') || (value.match(/:/g) || []).length >= 3 ? hidden : value)
  }
  const api = { diagnosticText }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.MGPrivacy = api
})(typeof globalThis === 'undefined' ? this : globalThis)
