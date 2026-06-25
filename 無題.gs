function testGitHubConnection() {
  // 1. スクリプトプロパティから安全にトークンを呼び出す
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  
  if (!token) {
    Logger.log("トークンが設定されていません。スクリプトプロパティを確認してください。");
    return;
  }

  // 2. GitHub APIのURL（今回は自分のユーザー情報を取得するAPI）
  const url = "https://api.github.com/user";
  
  // 3. 通信のための設定（ここにトークンを組み込みます）
  const options = {
    "method": "get",
    "headers": {
      "Authorization": "Bearer " + token,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    "muteHttpExceptions": true
  };
  
  // 4. 実際にGitHubにアクセスする
  try {
    const response = UrlFetchApp.fetch(url, options);
    const json = JSON.parse(response.getContentText());
    
    // 成功したらログにあなたのGitHubユーザー名などが表示されます
    Logger.log("接続成功！ユーザー名: " + json.login);
    Logger.log(json);
  } catch(e) {
    Logger.log("エラーが発生しました: " + e.toString());
  }
}