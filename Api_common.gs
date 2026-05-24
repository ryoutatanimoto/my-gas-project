/**
 * HTMLファイル内で別ファイルを読み込むための関数
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}