/**
 * ポータルサイトのエントリポイント
 * URLパラメータ（例: ?v=input-color）を受け取り、初期表示画面を制御します
 */
function doGet(e) {
  // テンプレートの作成
  const template = HtmlService.createTemplateFromFile('index_portal');
  
  // デフォルトの表示画面を 'dashboard' に設定
  let initialViewValue = 'dashboard'; 
  
  try {
    // パラメータ e や e.parameter が存在し、v が定義されている場合のみ上書き
    if (e && e.parameter && e.parameter.v) {
      initialViewValue = e.parameter.v;
    }
  } catch (err) {
    console.error('doGet parameter error:', err);
  }
  
  // テンプレート変数として明示的にセット
  // これにより HTML 側で <?= initialView ?> が "undefined" という文字列になるのを防ぎます
  template.initialView = initialViewValue;
  
  return template.evaluate()
    .setTitle('LIXIL 栗沢工場 押出課ポータル')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * 読み込みエラーを防ぐための安全な include 関数（Api_common.gsにあるものと同等）
 */
function include(filename) {
  try {
    return HtmlService.createHtmlOutputFromFile(filename).getContent();
  } catch (e) {
    // ファイルが見つからない場合などは、画面に「undefined」を出さず、HTMLコメントでエラーを残す
    return '<!-- Error loading file: ' + filename + ' -->';
  }
}