(() => {
  chrome.runtime.sendMessage({ type: "get-public-settings" }, (response) => {
    const state = document.querySelector("#state");
    if (chrome.runtime.lastError || !response?.ok) {
      state.textContent = "无法读取扩展设置，请重新打开。";
      return;
    }
    const { configured, provider, sitePatterns } = response.data;
    const siteCount = sitePatterns.length ? `已授权 ${sitePatterns.length} 个网站` : "尚未授权网站";
    state.textContent = `${configured ? `模型已配置（${provider}）` : "请先配置模型 API Key"}；${siteCount}。`;
  });

  document.querySelector("#open-settings").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
})();
