/**
 * 指定した月の分析データを取得する
 * @param {string} month 'YYYY-MM'
 */
function getApmAnalysisData(month) {
  // 実際にはBigQueryからデータを取得します
  // 本実装では input_apmTR, input_apm_subTR, master_formula_recipe, master_materials を結合します
  
  const results = {
    summary: { totalWeight: 0, totalCost: 0, avgYield: 0, outOfSystemWeight: 0 },
    daily: [],
    formulaRatio: {}
  };

  try {
    const rawData = _fetchApmResultsFromBQ(month);
    const materials = _fetchMaterialsForAnalysis();
    const recipes = _fetchRecipesForAnalysis();

    // 日ごとの集計
    // 1. 各日の配合バッチ数 × レシピ構成 から投入重量を算出
    // 2. タンク残量（%）の変化から実績消費量を算出
    // 3. FIFOロジック: 入荷日を考慮する場合はロット管理テーブルが必要だが、現状は直近の単価マスタを適用
    
    // 以下は集計イメージ（実際はBigQueryのSQLで一気に処理するのが高速）
    /*
    const sql = `
      WITH daily_batches AS (
        SELECT target_date, formula_id, actual_batches, is_external 
        FROM input_apmTR WHERE target_date LIKE '${month}%'
      ),
      cost_calc AS (
        SELECT b.target_date, 
               SUM(r.weight * m.unit_price * b.actual_batches) as total_cost,
               SUM(r.weight * b.actual_batches) as total_weight
        FROM daily_batches b
        JOIN master_formula_recipe r ON b.formula_id = r.formula_id
        JOIN master_materials m ON r.material_id = m.material_id
        GROUP BY 1
      )
      SELECT * FROM cost_calc ORDER BY target_date
    `;
    */

    // 暫定的なダミー生成（フロントエンド動作確認用）
    results.summary = { totalWeight: 52400, totalCost: 14850000, avgYield: 99.2, outOfSystemWeight: 840 };
    results.formulaRatio = { "TSC-R708W (無)": 450, "TSC-R708W (10%)": 320, "TSC-R708W (15%)": 120 };
    
    for(let i=1; i<=31; i++) {
      const d = String(i).padStart(2,'0');
      results.daily.push({
        date: `${month}-${d}`,
        topFormula: "TSC-R708W (無)",
        totalWeight: 1500 + Math.floor(Math.random() * 200),
        netWeight: 1480,
        outWeight: i % 10 === 0 ? 150 : 0,
        cost: 450000 + Math.floor(Math.random() * 50000),
        unitCost: 280 + Math.random() * 10,
        yield: 98.5 + Math.random() * 1.2
      });
    }

    return results;
  } catch (e) {
    console.error(e);
    return results;
  }
}

function _fetchApmResultsFromBQ(month) {
  // BigQueryから実績データを取得
  return []; 
}

function _fetchMaterialsForAnalysis() {
  // 原材料マスタ（単価含む）を取得
  return [];
}

function _fetchRecipesForAnalysis() {
  // 配合レシピを取得
  return [];
}