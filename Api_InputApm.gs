/**
 * LIXIL 栗沢工場 APMシステム - 材料投入実績一括API
 * [特徴]
 * 1. 1直開始・2直開始・3直開始・3直終了の4タイミングのレベル計%記録に完全対応
 * 2. 毎日使用する定番副原料のフロント自動マウントを完全サポート（「未分類」カテゴリも選択可能）
 * 3. 配合番号(No.1〜10)の選択時に配合マスタの名称を動的にマッチング
 * 4. ロットNo記入欄を廃止したすっきり実用設計
 */

const APM_INPUT_CONFIG = {
  projectId: 'lixil-workspace',
  datasetId: 'an1_kurisawa_oshidashi',
  location: 'asia-northeast1'
};

/**
 * 1. 配合マスタ及び原材料マスタの全取得 (input_apm画面初期化時)
 */
function getAllApmMasters() {
  try {
    // 原材料マスタ（重複を排除して、updated_atが最新のレコードを抽出）
    const materialsSql = `
      SELECT * FROM \`${APM_INPUT_CONFIG.projectId}.${APM_INPUT_CONFIG.datasetId}.master_materials\` 
      QUALIFY ROW_NUMBER() OVER(PARTITION BY material_name ORDER BY updated_at DESC) = 1
    `;
    const materials = runQuerySafe_(materialsSql);

    // 配合レシピマスタ
    const formulasSql = `SELECT * FROM \`${APM_INPUT_CONFIG.projectId}.${APM_INPUT_CONFIG.datasetId}.master_formulas\` ORDER BY formula_id`;
    const formulas = runQuerySafe_(formulasSql);

    return {
      materials: materials || [],
      formulas: formulas || []
    };
  } catch (e) {
    console.error("getAllApmMasters Error:", e);
    throw new Error("マスタの読み込みに失敗しました: " + e.toString());
  }
}

/**
 * 2. 指定した日付の登録済み実績を一括ロードしてフロントへマウント (自動ロード対応)
 */
function getApmDailyData(targetDate) {
  try {
    const formattedDate = targetDate; // YYYY-MM-DD
    
    // (A) 基本配合バッチ実績の取得
    const batchSql = `
      SELECT * FROM \`${APM_INPUT_CONFIG.projectId}.${APM_INPUT_CONFIG.datasetId}.input_apm_main\`
      WHERE work_date = '${formattedDate}'
      ORDER BY formula_id
    `;
    const batches = runQuerySafe_(batchSql);

    // (B) メイン原料 調整実績の取得
    const adjSql = `
      SELECT * FROM \`${APM_INPUT_CONFIG.projectId}.${APM_INPUT_CONFIG.datasetId}.input_apm_adjust\`
      WHERE work_date = '${formattedDate}'
      ORDER BY material_id
    `;
    const adjustments = runQuerySafe_(adjSql);

    // (C) タンクレベル・運用実績の取得 (4タイミング)
    const levelSql = `
      SELECT * FROM \`${APM_INPUT_CONFIG.projectId}.${APM_INPUT_CONFIG.datasetId}.input_apm_levels\`
      WHERE work_date = '${formattedDate}'
      ORDER BY tank_name
    `;
    const levels = runQuerySafe_(levelSql);

    // (D) 副原料投入実績の取得 (ロットNo除く)
    const subSql = `
      SELECT * FROM \`${APM_INPUT_CONFIG.projectId}.${APM_INPUT_CONFIG.datasetId}.input_apm_sub\`
      WHERE work_date = '${formattedDate}'
      ORDER BY material_id
    `;
    const subs = runQuerySafe_(subSql);

    return {
      batches: batches || [],
      adjustments: adjustments || [],
      levels: levels || [],
      subs: subs || []
    };
  } catch (e) {
    console.error("getApmDailyData Error:", e);
    throw new Error("実績データのロードに失敗しました: " + e.toString());
  }
}

/**
 * 3. 統合実績データ一括保存 (DELETE & INSERTによる原子的一括更新)
 */
function saveApmDailyCombinedToBigQuery(payload) {
  const date = payload.date;
  const timestamp = new Date().toISOString();

  try {
    ensureApmInputTables_(); // テーブルの存在保証

    // 💡 A. 同一日の古いレコードを一括クリア
    const deleteMain = `DELETE FROM \`${APM_INPUT_CONFIG.projectId}.${APM_INPUT_CONFIG.datasetId}.input_apm_main\` WHERE work_date = '${date}'`;
    const deleteAdj = `DELETE FROM \`${APM_INPUT_CONFIG.projectId}.${APM_INPUT_CONFIG.datasetId}.input_apm_adjust\` WHERE work_date = '${date}'`;
    const deleteLevel = `DELETE FROM \`${APM_INPUT_CONFIG.projectId}.${APM_INPUT_CONFIG.datasetId}.input_apm_levels\` WHERE work_date = '${date}'`;
    const deleteSub = `DELETE FROM \`${APM_INPUT_CONFIG.projectId}.${APM_INPUT_CONFIG.datasetId}.input_apm_sub\` WHERE work_date = '${date}'`;

    runQuerySafe_(deleteMain);
    runQuerySafe_(deleteAdj);
    runQuerySafe_(deleteLevel);
    runQuerySafe_(deleteSub);

    // 💡 B. 基本配合バッチ実績のインサート
    if (payload.batches && payload.batches.length > 0) {
      const rows = payload.batches.map(b => ({
        json: {
          work_date: date,
          formula_id: parseInt(b.formula_id),
          is_external: b.is_external === 1,
          s1_batches: b.s1_batches !== null ? parseInt(b.s1_batches) : null,
          s2_batches: b.s2_batches !== null ? parseInt(b.s2_batches) : null,
          s3_batches: b.s3_batches !== null ? parseInt(b.s3_batches) : null,
          updated_at: timestamp
        }
      }));
      const res = BigQuery.Tabledata.insertAll({ rows: rows }, APM_INPUT_CONFIG.projectId, APM_INPUT_CONFIG.datasetId, 'input_apm_main');
      if (res.insertErrors) throw new Error("基本配合の挿入に失敗しました");
    }

    // 💡 C. 調整（イレギュラー）投入実績のインサート
    if (payload.adjustments && payload.adjustments.length > 0) {
      const rows = payload.adjustments.map(a => ({
        json: {
          work_date: date,
          material_id: a.material_id,
          s1_weight: a.s1_weight !== null ? parseFloat(a.s1_weight) : null,
          s2_weight: a.s2_weight !== null ? parseFloat(a.s2_weight) : null,
          s3_weight: a.s3_weight !== null ? parseFloat(a.s3_weight) : null,
          updated_at: timestamp
        }
      }));
      const res = BigQuery.Tabledata.insertAll({ rows: rows }, APM_INPUT_CONFIG.projectId, APM_INPUT_CONFIG.datasetId, 'input_apm_adjust');
      if (res.insertErrors) throw new Error("調整材料の挿入に失敗しました");
    }

    // 💡 D. タンクレベル・運用設定のインサート (4タイミング完全保存)
    if (payload.levels && payload.levels.length > 0) {
      const rows = payload.levels.map(l => ({
        json: {
          work_date: date,
          tank_name: l.tank_name,
          level_1: l.level_1 !== null ? parseFloat(l.level_1) : null,
          level_2: l.level_2 !== null ? parseFloat(l.level_2) : null,
          level_3: l.level_3 !== null ? parseFloat(l.level_3) : null,
          level_4: l.level_4 !== null ? parseFloat(l.level_4) : null,
          storage_tank: l.storage_tank,
          discharge_tank: l.discharge_tank,
          updated_at: timestamp
        }
      }));
      const res = BigQuery.Tabledata.insertAll({ rows: rows }, APM_INPUT_CONFIG.projectId, APM_INPUT_CONFIG.datasetId, 'input_apm_levels');
      if (res.insertErrors) throw new Error("タンク残量の挿入に失敗しました");
    }

    // 💡 E. 副原料投入のインサート (lot_noフィールドの入力を排除しスキーマを一定に維持)
    if (payload.subs && payload.subs.length > 0) {
      const rows = payload.subs.map(s => ({
        json: {
          work_date: date,
          material_id: s.material_id,
          lot_no: null, // ロットNo記入欄は不要のため、NULLを挿入して既存スキーマとの互換性を保ちます
          prev_stock: s.prev_stock !== null ? parseFloat(s.prev_stock) : null,
          s1_weight: s.s1_weight !== null ? parseFloat(s.s1_weight) : null,
          s2_weight: s.s2_weight !== null ? parseFloat(s.s2_weight) : null,
          s3_weight: s.s3_weight !== null ? parseFloat(s.s3_weight) : null,
          dryer_weight: s.dryer_weight !== null ? parseFloat(s.dryer_weight) : null,
          current_stock: s.current_stock !== null ? parseFloat(s.current_stock) : null,
          updated_at: timestamp
        }
      }));
      const res = BigQuery.Tabledata.insertAll({ rows: rows }, APM_INPUT_CONFIG.projectId, APM_INPUT_CONFIG.datasetId, 'input_apm_sub');
      if (res.insertErrors) throw new Error("副原料実績の挿入に失敗しました");
    }

    return { success: true };
  } catch (e) {
    console.error("saveApmDailyCombinedToBigQuery Error:", e);
    return { success: false, message: e.toString() };
  }
}

/**
 * 4. 投入実績用BigQueryテーブル群のスキーマ確認・自動作成安全ロジック
 */
function ensureApmInputTables_() {
  const tables = [
    {
      id: 'input_apm_main',
      schema: [
        { name: 'work_date', type: 'STRING', mode: 'REQUIRED' },
        { name: 'formula_id', type: 'INTEGER', mode: 'REQUIRED' },
        { name: 'is_external', type: 'BOOLEAN', mode: 'REQUIRED' },
        { name: 's1_batches', type: 'INTEGER', mode: 'NULLABLE' },
        { name: 's2_batches', type: 'INTEGER', mode: 'NULLABLE' },
        { name: 's3_batches', type: 'INTEGER', mode: 'NULLABLE' },
        { name: 'updated_at', type: 'TIMESTAMP', mode: 'NULLABLE' }
      ]
    },
    {
      id: 'input_apm_adjust',
      schema: [
        { name: 'work_date', type: 'STRING', mode: 'REQUIRED' },
        { name: 'material_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 's1_weight', type: 'FLOAT', mode: 'NULLABLE' },
        { name: 's2_weight', type: 'FLOAT', mode: 'NULLABLE' },
        { name: 's3_weight', type: 'FLOAT', mode: 'NULLABLE' },
        { name: 'updated_at', type: 'TIMESTAMP', mode: 'NULLABLE' }
      ]
    },
    {
      id: 'input_apm_levels',
      schema: [
        { name: 'work_date', type: 'STRING', mode: 'REQUIRED' },
        { name: 'tank_name', type: 'STRING', mode: 'REQUIRED' },
        { name: 'level_1', type: 'FLOAT', mode: 'NULLABLE' },
        { name: 'level_2', type: 'FLOAT', mode: 'NULLABLE' },
        { name: 'level_3', type: 'FLOAT', mode: 'NULLABLE' },
        { name: 'level_4', type: 'FLOAT', mode: 'NULLABLE' },
        { name: 'storage_tank', type: 'STRING', mode: 'NULLABLE' },
        { name: 'discharge_tank', type: 'STRING', mode: 'NULLABLE' },
        { name: 'updated_at', type: 'TIMESTAMP', mode: 'NULLABLE' }
      ]
    },
    {
      id: 'input_apm_sub',
      schema: [
        { name: 'work_date', type: 'STRING', mode: 'REQUIRED' },
        { name: 'material_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'lot_no', type: 'STRING', mode: 'NULLABLE' },
        { name: 'prev_stock', type: 'FLOAT', mode: 'NULLABLE' },
        { name: 's1_weight', type: 'FLOAT', mode: 'NULLABLE' },
        { name: 's2_weight', type: 'FLOAT', mode: 'NULLABLE' },
        { name: 's3_weight', type: 'FLOAT', mode: 'NULLABLE' },
        { name: 'dryer_weight', type: 'FLOAT', mode: 'NULLABLE' },
        { name: 'current_stock', type: 'FLOAT', mode: 'NULLABLE' },
        { name: 'updated_at', type: 'TIMESTAMP', mode: 'NULLABLE' }
      ]
    }
  ];

  tables.forEach(t => {
    try {
      BigQuery.Tables.get(APM_INPUT_CONFIG.projectId, APM_INPUT_CONFIG.datasetId, t.id);
    } catch (e) {
      const table = {
        tableReference: {
          projectId: APM_INPUT_CONFIG.projectId,
          datasetId: APM_INPUT_CONFIG.datasetId,
          tableId: t.id
        },
        schema: { fields: t.schema }
      };
      BigQuery.Tables.insert(table, APM_INPUT_CONFIG.projectId, APM_INPUT_CONFIG.datasetId);
      console.log(`[APM Table Created]: ${t.id}`);
    }
  });
}

/**
 * 内部クエリ実行関数
 */
function runQuerySafe_(sql) {
  const request = {
    query: sql,
    useLegacySql: false,
    location: APM_INPUT_CONFIG.location
  };

  try {
    let queryResponse = BigQuery.Jobs.query(request, APM_INPUT_CONFIG.projectId);
    
    if (!queryResponse.jobComplete) {
      const jobId = queryResponse.jobReference.jobId;
      const jobOptions = { location: APM_INPUT_CONFIG.location };
      let job = BigQuery.Jobs.get(APM_INPUT_CONFIG.projectId, jobId, jobOptions);
      
      while (job.status.state !== 'DONE') {
        Utilities.sleep(200);
        job = BigQuery.Jobs.get(APM_INPUT_CONFIG.projectId, jobId, jobOptions);
      }
      
      if (job.status.errorResult) {
        throw new Error(job.status.errorResult.message);
      }
      
      if (sql.trim().toUpperCase().startsWith('SELECT')) {
        queryResponse = BigQuery.Jobs.getQueryResults(APM_INPUT_CONFIG.projectId, jobId, jobOptions);
      } else {
        return null;
      }
    }

    if (!queryResponse || !queryResponse.rows) return [];
    const fields = queryResponse.schema.fields;
    return queryResponse.rows.map(row => {
      const obj = {};
      row.f.forEach((cell, i) => {
        let val = cell.v;
        if (fields[i].type === 'FLOAT' || fields[i].type === 'INTEGER') {
          val = val !== null ? Number(val) : null;
        } else if (fields[i].type === 'BOOLEAN') {
          val = val !== null ? (val === 'true' || val === true) : null;
        }
        obj[fields[i].name] = val;
      });
      return obj;
    });

  } catch (e) {
    console.error('runQuerySafe_ failed:', sql, e);
    throw e;
  }
}