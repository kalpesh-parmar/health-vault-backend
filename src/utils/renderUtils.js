const fs = require("fs/promises");
const path = require("path");
const Mustache = require("mustache");

const templateDirectory = path.join(__dirname, "..", "resources", "emailTemplates");

class RenderUtils {
  constructor() {
    this.cache = new Map(); // optional caching
  }

  async loadTemplate(fileName) {
    const filePath = path.join(templateDirectory, fileName);

    if (this.cache.has(filePath)) {
      return this.cache.get(filePath);
    }

    const content = await fs.readFile(filePath, "utf8");
    this.cache.set(filePath, content);

    return content;
  }

  async render(templateName, variables = {}) {
    const [baseTemplate, contentTemplate] = await Promise.all([
      this.loadTemplate("baseTemplate.html"),
      this.loadTemplate(`${templateName}.html`),
    ]);

    const contentHtml = Mustache.render(contentTemplate, variables);

    return Mustache.render(baseTemplate, {
      ...variables,
      content: contentHtml,
    });
  }

  clearCache() {
    this.cache.clear();
  }
}

module.exports = new RenderUtils();
