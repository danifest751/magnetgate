;(function (root) {
  function diagnosticText(value) {
    return String(value ?? '')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[адрес скрыт]')
      .replace(/(?:[a-f\d]{0,4}:){2,}[a-f\d:.]*/gi, value =>
        value.includes('::') || (value.match(/:/g) || []).length >= 3 ? '[адрес скрыт]' : value)
  }
  const api = { diagnosticText }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.MGPrivacy = api
})(typeof globalThis === 'undefined' ? this : globalThis)
