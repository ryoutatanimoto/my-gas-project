/**
 * LIXIL 栗沢工場 APMシステム - マスタ管理API (最終安定版)
 * [特徴]
 * 1. 同名材料の重複排除: updated_at が最新のレコードのみを抽出
 * 2. リージョン固定: asia-northeast1 (東京) でのジョブ実行を保証
 * 3. 一括処理: MERGE文による高速な一括インポート・上書きに対応
 */

const CONFIG = {
  projectId: 'lixil-workspace',
  datasetId: 'an1_kurisawa_oshidashi'
};

/**
 * 1. マスタ画面の初期データを一括取得 (重複排除版)
 */
function getMasterData() {
  try {
    // QUALIFY句を使用し、material_nameごとに最新のupdated_atを持つ1行だけを抽出する
    const materialsSql = `
      SELECT * FROM \`${CONFIG.projectId}.${CONFIG.datasetId}.master_materials\` 
      QUALIFY ROW_NUMBER() OVER(PARTITION BY material_name ORDER BY updated_at DESC) = 1
      ORDER BY category, material_name
    `;
    const materials = runQuery_(materialsSql);

    // 配合マスタヘッダー (1-10スロット用)
    const formulasSql = `SELECT * FROM \`${CONFIG.projectId}.${CONFIG.datasetId}.master_formulas\` ORDER BY formula_id`;
    const formulaHeaders = runQuery_(formulasSql);

    // 配合レシピ詳細
    const recipeSql = `SELECT * FROM \`${CONFIG.projectId}.${CONFIG.datasetId}.master_formula_recipe\``;
    const recipes = runQuery_(recipeSql);

    // フロントエンド表示用のオブジェクト構築
    const formulasObj = {};
    for(let i=1; i<=10; i++) {
      formulasObj[i] = { formula_id: i, formula_name: '', std_total_weight: 0, recipe: [] };
    }

    if (formulaHeaders && formulaHeaders.length > 0) {
      formulaHeaders.forEach(h => {
        const id = parseInt(h.formula_id);
        if (id >= 1 && id <= 10) {
          formulasObj[id] = {
            ...h,
            recipe: recipes ? recipes.filter(r => parseInt(r.formula_id) === id) : []
          };
        }
      });
    }

    return { 
      materials: materials || [], 
      formulas: formulasObj 
    };
  } catch (e) {
    console.error('getMasterData Error:', e);
    throw new Error('データ読み込み中にエラーが発生しました。\n' + e.toString());
  }
}

/**
 * 2. 原材料の保存・修正
 */
function saveMaterial(data) {
  const cleanName = data.material_name ? data.material_name.replace(/'/g, "\\'") : "";
  const cleanCat = data.category ? data.category.replace(/'/g, "\\'") : "未分類";
  const cleanUnit = data.unit ? data.unit.replace(/'/g, "\\'") : "kg";
  const price = (data.unit_price === "" || isNaN(data.unit_price)) ? 0 : parseFloat(data.unit_price);
  
  let sql = "";
  if (data.material_id && data.material_id !== "") {
    // 既存IDの修正: updated_atを更新
    sql = `
      UPDATE \`${CONFIG.projectId}.${CONFIG.datasetId}.master_materials\`
      SET material_name = '${cleanName}',
          category = '${cleanCat}',
          unit_price = CAST(${price} AS FLOAT64),
          unit = '${cleanUnit}',
          updated_at = CURRENT_TIMESTAMP()
      WHERE material_id = '${data.material_id}'
    `;
  } else {
    // 新規登録
    const newId = 'MAT' + Utilities.formatDate(new Date(), "JST", "yyyyMMddHHmmss");
    sql = `
      INSERT INTO \`${CONFIG.projectId}.${CONFIG.datasetId}.master_materials\` 
      (material_id, material_name, category, unit_price, unit, updated_at)
      VALUES ('${newId}', '${cleanName}', '${cleanCat}', CAST(${price} AS FLOAT64), '${cleanUnit}', CURRENT_TIMESTAMP())
    `;
  }
  
  try {
    runQuery_(sql);
    return { status: 'success' };
  } catch (e) {
    console.error('saveMaterial Error:', e);
    throw new Error('原材料の保存に失敗しました: ' + e.toString());
  }
}

/**
 * 3. 原材料の一括インポート (重複排除MERGE版)
 * 名前が被っている場合は、最新の単価で既存行を更新する
 */
function importMaterials(dataArray) {
  if (!dataArray || dataArray.length === 0) return { status: 'success', count: 0 };

  const nowStr = Utilities.formatDate(new Date(), "JST", "yyyyMMddHHmmss");
  
  const sourceRows = dataArray.map((data, index) => {
    const id = data.material_id || ('MAT' + nowStr + index.toString().padStart(3, '0'));
    const cleanName = data.material_name ? data.material_name.replace(/'/g, "\\'") : "";
    const cleanCat = data.category ? data.category.replace(/'/g, "\\'") : "未分類";
    const cleanUnit = data.unit ? data.unit.replace(/'/g, "\\'") : "kg";
    const price = isNaN(data.unit_price) ? 0 : parseFloat(data.unit_price);
    
    return `SELECT '${id}' as id, '${cleanName}' as name, '${cleanCat}' as cat, ${price} as prc, '${cleanUnit}' as unt`;
  }).join(' UNION ALL ');

  const sql = `
    MERGE \`${CONFIG.projectId}.${CONFIG.datasetId}.master_materials\` T
    USING (${sourceRows}) S
    ON T.material_name = S.name
    WHEN MATCHED THEN
      UPDATE SET unit_price = CAST(S.prc AS FLOAT64), updated_at = CURRENT_TIMESTAMP()
    WHEN NOT MATCHED THEN
      INSERT (material_id, material_name, category, unit_price, unit, updated_at)
      VALUES (S.id, S.name, S.cat, CAST(S.prc AS FLOAT64), S.unt, CURRENT_TIMESTAMP())
  `;

  try {
    runQuery_(sql);
    return { status: 'success', count: dataArray.length };
  } catch (e) {
    console.error('importMaterials Error:', e);
    throw new Error('一括インポートに失敗しました: ' + e.toString());
  }
}

/**
 * 4. 原材料の削除
 */
function deleteMaterial(materialId) {
  try {
    const checkSql = `SELECT COUNT(*) as count FROM \`${CONFIG.projectId}.${CONFIG.datasetId}.master_formula_recipe\` WHERE material_id = '${materialId}'`;
    const checkResult = runQuery_(checkSql);
    
    if (checkResult && parseInt(checkResult[0].count) > 0) {
      throw new Error('この材料は現在配合レシピで使用されているため削除できません。');
    }

    const sql = `DELETE FROM \`${CONFIG.projectId}.${CONFIG.datasetId}.master_materials\` WHERE material_id = '${materialId}'`;
    runQuery_(sql);
    return { status: 'success', message: '削除完了' };
  } catch (e) {
    console.error('deleteMaterial Error:', e);
    throw new Error(e.toString());
  }
}

/**
 * 5. 配合レシピの保存 (Header & Detail)
 */
function saveFormula(data) {
  const cleanFname = data.formula_name ? data.formula_name.replace(/'/g, "\\'") : "未設定";
  const targetWeight = (data.std_total_weight === "" || isNaN(data.std_total_weight)) ? 0 : parseFloat(data.std_total_weight);
  const fId = parseInt(data.formula_id);

  try {
    const headerSql = `
      MERGE \`${CONFIG.projectId}.${CONFIG.datasetId}.master_formulas\` T
      USING (SELECT CAST(${fId} AS INT64) as id, CAST('${cleanFname}' AS STRING) as name, CAST(${targetWeight} AS FLOAT64) as weight) S
      ON T.formula_id = S.id
      WHEN MATCHED THEN 
        UPDATE SET formula_name = S.name, std_total_weight = S.weight, updated_at = CURRENT_TIMESTAMP()
      WHEN NOT MATCHED THEN 
        INSERT (formula_id, formula_name, std_total_weight, updated_at) VALUES (S.id, S.name, S.weight, CURRENT_TIMESTAMP())
    `;
    runQuery_(headerSql);

    runQuery_(`DELETE FROM \`${CONFIG.projectId}.${CONFIG.datasetId}.master_formula_recipe\` WHERE formula_id = CAST(${fId} AS INT64)`);

    if (data.recipe && data.recipe.length > 0) {
      const values = data.recipe.map(r => {
        const rowWeight = (r.std_weight === "" || isNaN(r.std_weight)) ? 0 : parseFloat(r.std_weight);
        return `(CAST(${fId} AS INT64), '${r.material_id}', CAST(${rowWeight} AS FLOAT64), CURRENT_TIMESTAMP())`;
      }).join(',');
      
      const insertSql = `
        INSERT INTO \`${CONFIG.projectId}.${CONFIG.datasetId}.master_formula_recipe\` (formula_id, material_id, std_weight, updated_at)
        VALUES ${values}
      `;
      runQuery_(insertSql);
    }
    return { status: 'success' };
  } catch (e) {
    console.error('saveFormula Error:', e);
    throw new Error('レシピの保存に失敗しました: ' + e.toString());
  }
}

/**
 * 6. 配合スロットの完全初期化
 */
function deleteFormula(formulaId) {
  try {
    const fId = parseInt(formulaId);
    runQuery_(`DELETE FROM \`${CONFIG.projectId}.${CONFIG.datasetId}.master_formula_recipe\` WHERE formula_id = CAST(${fId} AS INT64)`);
    runQuery_(`DELETE FROM \`${CONFIG.projectId}.${CONFIG.datasetId}.master_formulas\` WHERE formula_id = CAST(${fId} AS INT64)`);
    return { status: 'success' };
  } catch (e) {
    console.error('deleteFormula Error:', e);
    throw new Error('スロットのクリアに失敗しました。');
  }
}

/**
 * 共通関数: BigQuery実行エンジン (リージョン固定・完了待機版)
 */
function runQuery_(sql) {
  const location = 'asia-northeast1';
  const request = {
    query: sql,
    useLegacySql: false,
    location: location
  };

  try {
    if (typeof BigQuery === 'undefined') {
      throw new Error('BigQuery APIが「サービス」に追加されていません。');
    }

    let queryResponse = BigQuery.Jobs.query(request, CONFIG.projectId);
    
    if (!queryResponse.jobComplete) {
      const jobId = queryResponse.jobReference.jobId;
      const jobOptions = { location: location };
      let job = BigQuery.Jobs.get(CONFIG.projectId, jobId, jobOptions);
      
      while (job.status.state !== 'DONE') {
        Utilities.sleep(500);
        job = BigQuery.Jobs.get(CONFIG.projectId, jobId, jobOptions);
      }
      
      if (job.status.errorResult) {
        throw new Error(job.status.errorResult.message);
      }
      
      if (sql.trim().toUpperCase().startsWith('SELECT')) {
        queryResponse = BigQuery.Jobs.getQueryResults(CONFIG.projectId, jobId, jobOptions);
      } else {
        return null;
      }
    }

    return parseTableResults_(queryResponse);

  } catch (e) {
    console.error('Query Failed:', sql, e);
    throw e;
  }
}

/**
 * BigQueryの結果をJSON配列に変換
 */
function parseTableResults_(response) {
  if (!response || !response.rows) return [];
  const fields = response.schema.fields;
  return response.rows.map(row => {
    const obj = {};
    row.f.forEach((cell, i) => {
      obj[fields[i].name] = cell.v;
    });
    return obj;
  });
}