(() => {
  const defaults = {
    provider: "deepseek",
    model: "deepseek-chat",
    apiUrl: "https://api.deepseek.com/chat/completions",
    apiKey: "",
    sitePatterns: []
  };
  const providerDefaults = {
    deepseek: { model: "deepseek-chat", apiUrl: "https://api.deepseek.com/chat/completions" },
    kimi: { model: "moonshot-v1-8k", apiUrl: "https://api.moonshot.cn/v1/chat/completions" },
    glm: { model: "glm-4-flash", apiUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions" },
    custom: { model: "", apiUrl: "" }
  };
  const form = document.querySelector("#provider-form");
  const providerField = document.querySelector("#provider");
  const apiUrlField = document.querySelector("#api-url");
  const modelField = document.querySelector("#model");
  const keyField = document.querySelector("#api-key");
  const status = document.querySelector("#status");
  let keySaved = false;
  let savedSettings = { ...defaults };

  function chromeCall(owner, fn, ...args) {
    return new Promise((resolve, reject) => {
      fn.call(owner, ...args, (result) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result);
      });
    });
  }

  function messageCall(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "操作失败，请重试。"));
          return;
        }
        resolve(response.data);
      });
    });
  }

  function setStatus(message, kind = "") {
    status.textContent = message;
    status.className = `status ${kind}`;
  }

  function originPattern(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error("请输入有效的网站或 API 地址。");
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("仅支持 HTTP 或 HTTPS 网站。");
    }
    return `${url.origin}/*`;
  }

  async function requestPermission(patterns) {
    const granted = await chromeCall(chrome.permissions, chrome.permissions.request, { origins: patterns });
    if (!granted) throw new Error("未获得所需的网站访问授权。");
  }

  function providerChanged() {
    const next = providerDefaults[providerField.value];
    if (!next) return;
    if (providerField.value !== savedSettings.provider) {
      apiUrlField.value = next.apiUrl;
      modelField.value = next.model;
    }
  }

  function renderSites() {
    const list = document.querySelector("#site-list");
    list.replaceChildren();
    for (const pattern of savedSettings.sitePatterns) {
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = pattern.replace(/\/\*$/, "");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "移除";
      remove.addEventListener("click", () => removeSite(pattern));
      item.append(label, remove);
      list.append(item);
    }
    if (!savedSettings.sitePatterns.length) {
      const item = document.createElement("li");
      item.textContent = "尚未授权网站。添加网站后重新加载页面即可使用划词工具。";
      list.append(item);
    }
  }

  async function saveSites(patterns) {
    savedSettings.sitePatterns = [...new Set(patterns)];
    await chromeCall(chrome.storage.local, chrome.storage.local.set, { sitePatterns: savedSettings.sitePatterns });
    await messageCall({ type: "register-site-scripts" });
    renderSites();
  }

  async function removeSite(pattern) {
    try {
      const removed = await chromeCall(chrome.permissions, chrome.permissions.remove, { origins: [pattern] });
      if (!removed) throw new Error("浏览器未能撤销该网站权限。");
      await saveSites(savedSettings.sitePatterns.filter((item) => item !== pattern));
      setStatus("网站权限已移除。已打开的页面需要重新加载。", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  async function initialize() {
    const stored = await chromeCall(chrome.storage.local, chrome.storage.local.get, Object.keys(defaults));
    savedSettings = { ...defaults, ...stored };
    providerField.value = savedSettings.provider;
    apiUrlField.value = savedSettings.apiUrl;
    modelField.value = savedSettings.model;
    keyField.value = savedSettings.apiKey;
    keySaved = Boolean(savedSettings.apiKey);
    renderSites();
  }

  providerField.addEventListener("change", providerChanged);
  document.querySelector("#toggle-key").addEventListener("click", (event) => {
    const visible = keyField.type === "password";
    keyField.type = visible ? "text" : "password";
    event.currentTarget.textContent = visible ? "隐藏" : "显示";
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const apiUrl = apiUrlField.value.trim();
      const apiPattern = originPattern(apiUrl);
      if (!apiUrl.startsWith("https://")) throw new Error("模型 API 地址必须使用 HTTPS。");
      const parsedApiUrl = new URL(apiUrl);
      if (parsedApiUrl.username || parsedApiUrl.password || parsedApiUrl.search || parsedApiUrl.hash) {
        throw new Error("API 地址不能包含账号密码、查询参数或片段，请将认证信息填入 API Key。");
      }
      const apiKey = keyField.value.trim();
      if (!apiKey && !keySaved) throw new Error("请填写 API Key。");
      const model = modelField.value.trim();
      if (!model) throw new Error("请填写模型名称。");
      await requestPermission([apiPattern]);
      const nextSettings = {
        provider: providerField.value,
        apiUrl,
        model,
        apiKey: apiKey || savedSettings.apiKey,
        sitePatterns: savedSettings.sitePatterns
      };
      await chromeCall(chrome.storage.local, chrome.storage.local.set, nextSettings);
      savedSettings = nextSettings;
      keySaved = Boolean(nextSettings.apiKey);
      keyField.value = nextSettings.apiKey;
      setStatus("设置已保存。可以测试连接。", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  document.querySelector("#test-provider").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    setStatus("正在测试模型服务…");
    try {
      await messageCall({ type: "provider-test" });
      setStatus("连接成功，模型已返回响应。", "success");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector("#clear-key").addEventListener("click", async () => {
    try {
      await chromeCall(chrome.storage.local, chrome.storage.local.remove, ["apiKey"]);
      savedSettings.apiKey = "";
      keyField.value = "";
      keySaved = false;
      setStatus("API Key 已从本地扩展存储中删除。", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  document.querySelector("#site-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.querySelector("#site-url");
    try {
      const pattern = originPattern(input.value.trim());
      await requestPermission([pattern]);
      await saveSites([...savedSettings.sitePatterns, pattern]);
      input.value = "";
      setStatus("网站已添加。请重新加载该网站页面以启用划词。", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  document.querySelector("#all-sites").addEventListener("click", async () => {
    try {
      const patterns = ["http://*/*", "https://*/*"];
      await requestPermission(patterns);
      await saveSites(patterns);
      setStatus("已启用所有 HTTP/HTTPS 网站。重新加载已打开页面后生效。", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  document.querySelector("#clear-cache").addEventListener("click", async () => {
    try {
      await messageCall({ type: "clear-cache" });
      setStatus("本次会话翻译缓存已清除。", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  initialize().catch((error) => setStatus(error.message, "error"));
})();
