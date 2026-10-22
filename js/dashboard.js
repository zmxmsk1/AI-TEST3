"use strict";

/*
 * 이 파일은 빌드 도구나 외부 라이브러리 없이 생산일지 CSV를 읽어 화면을
 * 갱신합니다. 처음 코드를 살펴보는 경우 아래 순서로 읽으면 흐름을 따라가기
 * 쉽습니다.
 *
 * 1) CSV_FILE_COLUMNS: 제공된 예시 CSV의 열 이름과 화면에서 사용하는 의미
 * 2) readCsvFile / parseCsvText: 파일 인코딩과 CSV 문법 처리
 * 3) convertRowsToRolls: 각 CSV 행을 검증하고 화면용 데이터로 변환
 * 4) renderDashboard 및 하위 함수: 요약, 세로 막대 그래프, 전체/NG 표 출력
 *
 * 화면에 표시하는 문자열은 innerHTML에 넣지 않고 textContent로 삽입합니다.
 * 따라서 CSV 안에 HTML과 비슷한 문자가 들어 있어도 브라우저 코드로 실행되지
 * 않고 일반 텍스트로 표시됩니다.
 */

(() => {
  /*
   * 예시 생산일지의 열 이름을 화면 데이터의 고정된 순서와 연결합니다.
   * CSV 열이 추가/재정렬되더라도 이름으로 위치를 찾아 읽을 수 있습니다.
   * 생산시간과 로스시간의 원본 단위는 두 열 이름에 명시된 분입니다.
   */
  const CSV_FILE_COLUMNS = [
    { key: "date", header: "생산일자" },
    { key: "equipment", header: "설비명" },
    { key: "mesNo", header: "MES_NO" },
    { key: "model", header: "생산모델" },
    { key: "thicknessLeft", header: "두께_좌" },
    { key: "thicknessCenter", header: "두께_중" },
    { key: "thicknessRight", header: "두께_우" },
    { key: "weight", header: "무게" },
    { key: "permeability", header: "통기도" },
    { key: "tensileStrength", header: "인장강도" },
    { key: "productionMinutes", header: "생산시간_분" },
    { key: "lossMinutes", header: "로스시간_분" },
    { key: "judgment", header: "판정" }
  ];

  /*
   * 표는 읽기 편한 한국어 이름을 사용하되, CSV 파일에 들어 있는 원래 열
   * 순서와 동일하게 배치합니다. 두께편차는 CSV에 원래 들어 있지 않아
   * 좌/중/우 두께 값에서 계산하며, fixedDecimal은 소수 첫째 자리 표시를 뜻합니다.
   */
  const TABLE_COLUMNS = [
    { key: "date", label: "생산일자", numeric: false },
    { key: "equipment", label: "설비명", numeric: false },
    { key: "mesNo", label: "MES 번호", numeric: false },
    { key: "model", label: "생산모델", numeric: false },
    { key: "thicknessLeft", label: "두께 좌", numeric: true },
    { key: "thicknessCenter", label: "두께 중", numeric: true },
    { key: "thicknessRight", label: "두께 우", numeric: true },
    { key: "thicknessDeviation", label: "두께편차", numeric: true, fixedDecimal: true },
    { key: "weight", label: "무게", numeric: true },
    { key: "permeability", label: "통기도", numeric: true },
    { key: "tensileStrength", label: "인장강도", numeric: true },
    { key: "productionMinutes", label: "생산시간(분)", numeric: true },
    { key: "lossMinutes", label: "로스시간(분)", numeric: true },
    { key: "judgment", label: "판정", numeric: false }
  ];

  /*
   * 이 화면에서 사용하는 DOM 요소를 한 곳에서 가져옵니다. HTML의 id를
   * 바꾸게 되면 이 목록도 함께 수정해야 하므로 관련 위치를 모아 둡니다.
   */
  const elements = {
    fileInput: document.getElementById("csv-file"),
    status: document.getElementById("file-status"),
    dateRange: document.getElementById("date-range"),
    totalRolls: document.getElementById("total-rolls"),
    defectRate: document.getElementById("defect-rate"),
    defectDetail: document.getElementById("defect-detail"),
    utilizationRate: document.getElementById("utilization-rate"),
    totalLossTime: document.getElementById("total-loss-time"),
    equipmentChart: document.getElementById("equipment-chart"),
    dailyChart: document.getElementById("daily-chart"),
    modelChart: document.getElementById("model-chart"),
    equipmentTimeChart: document.getElementById("equipment-time-chart"),
    tableBody: document.getElementById("roll-table-body"),
    tableCount: document.getElementById("table-count"),
    showAllButton: document.getElementById("show-all-button"),
    showNgButton: document.getElementById("show-ng-button"),
    allRowCount: document.getElementById("all-row-count"),
    ngRowCount: document.getElementById("ng-row-count")
  };

  /*
   * 현재 선택된 파일의 원본 행과 표의 필터 상태를 보관합니다.
   * NG 보기 전환은 전체 데이터의 요약/그래프를 바꾸지 않고 표에만 적용합니다.
   */
  let currentRolls = [];
  let showNgOnly = false;

  /*
   * 브라우저가 지원하는 한글 인코딩 이름(euc-kr)은 CP949로 저장된 예시 파일도
   * 읽을 수 있습니다. 우선 UTF-8을 엄격하게 검사하고, 유효하지 않을 때에만
   * 한글 Windows 인코딩으로 다시 읽습니다. 잘못된 글자가 조용히 섞인 채
   * 대시보드에 표시되는 일을 막기 위해 두 방식이 모두 실패하면 오류를 알립니다.
   */
  async function readCsvFile(file) {
    const bytes = await file.arrayBuffer();

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (utf8Error) {
      try {
        return new TextDecoder("euc-kr", { fatal: true }).decode(bytes);
      } catch (koreanEncodingError) {
        throw new Error("파일 인코딩을 확인할 수 없습니다. UTF-8 또는 CP949 CSV를 선택해 주세요.");
      }
    }
  }

  /*
   * 쉼표로 단순 분리하면 따옴표 안의 쉼표와 줄바꿈이 데이터로 처리되지 않습니다.
   * 이 함수는 CSV의 큰따옴표 규칙(큰따옴표 두 개는 따옴표 하나)을 직접 읽어
   * 외부 라이브러리 없이 행/열 배열로 바꿉니다. 큰따옴표가 닫히지 않은 파일은
   * 불완전한 데이터로 간주해 오류를 발생시킵니다.
   */
  function parseCsvText(text) {
    const rows = [];
    let row = [];
    let field = "";
    let insideQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];

      if (insideQuotes) {
        if (character === '"') {
          if (text[index + 1] === '"') {
            field += '"';
            index += 1;
          } else {
            insideQuotes = false;
          }
        } else {
          field += character;
        }
        continue;
      }

      if (character === '"' && field.length === 0) {
        insideQuotes = true;
      } else if (character === ",") {
        row.push(field);
        field = "";
      } else if (character === "\n" || character === "\r") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";

        /* Windows 줄바꿈(\r\n)은 한 번만 행 끝으로 처리합니다. */
        if (character === "\r" && text[index + 1] === "\n") {
          index += 1;
        }
      } else {
        field += character;
      }
    }

    if (insideQuotes) {
      throw new Error("CSV의 따옴표가 올바르게 닫히지 않았습니다.");
    }

    /*
     * 파일 끝에 줄바꿈이 있는 경우 이미 마지막 행이 저장되어 있습니다.
     * 마지막 필드나 행에 실제 값이 남아 있을 때만 추가하여 빈 행을 만들지 않습니다.
     */
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }

    return rows.filter((csvRow) => csvRow.some((value) => value.trim() !== ""));
  }

  /*
   * CSV 행을 대시보드가 이해하는 객체로 바꿉니다. 열 이름을 기준으로 인덱스를
   * 찾으므로 열 순서는 자유롭지만, 필요한 헤더가 없거나 필수 값이 잘못된 행은
   * 어느 행에서 문제가 생겼는지 알려 주고 파일 전체를 거부합니다.
   */
  function convertRowsToRolls(rows) {
    if (rows.length < 2) {
      throw new Error("헤더와 생산 데이터가 들어 있는 CSV를 선택해 주세요.");
    }

    const headers = rows[0].map((header) => header.replace(/^\uFEFF/, "").trim());
    const columnIndexes = new Map();

    CSV_FILE_COLUMNS.forEach((column) => {
      const columnIndex = headers.indexOf(column.header);
      if (columnIndex === -1) {
        throw new Error(`필수 열 '${column.header}'을(를) 찾을 수 없습니다.`);
      }
      columnIndexes.set(column.key, columnIndex);
    });

    return rows.slice(1).map((csvRow, rowIndex) => {
      const sourceRowNumber = rowIndex + 2;
      const values = {};

      CSV_FILE_COLUMNS.forEach((column) => {
        const value = csvRow[columnIndexes.get(column.key)];
        if (value === undefined) {
          throw new Error(`${sourceRowNumber}번째 행의 열 개수가 헤더와 다릅니다.`);
        }
        values[column.key] = value.trim();
      });

      if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
        throw new Error(`${sourceRowNumber}번째 행의 생산일자 형식이 YYYY-MM-DD가 아닙니다.`);
      }

      const numericKeys = [
        "thicknessLeft",
        "thicknessCenter",
        "thicknessRight",
        "weight",
        "permeability",
        "tensileStrength",
        "productionMinutes",
        "lossMinutes"
      ];

      numericKeys.forEach((key) => {
        const normalizedValue = values[key].replace(/,/g, "");
        const numericValue = Number(normalizedValue);
        if (normalizedValue === "" || !Number.isFinite(numericValue) || numericValue < 0) {
          const columnName = CSV_FILE_COLUMNS.find((column) => column.key === key).header;
          throw new Error(`${sourceRowNumber}번째 행의 '${columnName}' 값이 올바른 숫자가 아닙니다.`);
        }
        values[key] = numericValue;
      });

      if (values.equipment === "" || values.mesNo === "" || values.judgment === "") {
        throw new Error(`${sourceRowNumber}번째 행에 설비명, MES 번호 또는 판정이 비어 있습니다.`);
      }

      values.judgment = values.judgment.toUpperCase();
      /*
       * 좌/중/우 두께의 최댓값에서 최솟값을 빼 폭 방향 편차를 구합니다.
       * 반올림한 숫자 값은 표에서도 소수 첫째 자리까지 보이도록 사용합니다.
       */
      values.thicknessDeviation = Number((
        Math.max(values.thicknessLeft, values.thicknessCenter, values.thicknessRight) -
        Math.min(values.thicknessLeft, values.thicknessCenter, values.thicknessRight)
      ).toFixed(1));
      return values;
    });
  }

  /*
   * 소수점이 있는 숫자는 최대 한 자리까지만 보이고 정수는 소수점 없이 보입니다.
   * 요약 카드의 퍼센트는 별도의 formatPercentage 함수를 사용해 항상 한 자리로
   * 통일합니다.
   */
  function formatNumber(value) {
    return new Intl.NumberFormat("ko-KR", {
      maximumFractionDigits: 1
    }).format(value);
  }

  function formatPercentage(value) {
    return `${value.toFixed(1)}%`;
  }

  /*
   * 가로 막대를 지우고 세로 막대 차트를 그립니다. 각 카테고리(entry)는
   * 하나 이상의 값(series)을 가질 수 있습니다. 설비/일자/모델은 한 색 막대,
   * 설비 시간 비교는 생산시간과 로스시간 두 색 막대를 같은 눈금으로 그립니다.
   * 막대 높이는 최댓값 대비 퍼센트이며 차트 라이브러리는 사용하지 않습니다.
   */
  function renderVerticalChart(container, entries, series, emptyMessage) {
    container.replaceChildren();

    if (entries.length === 0) {
      container.classList.add("empty-chart");
      const message = document.createElement("p");
      message.className = "empty-message";
      message.textContent = emptyMessage;
      container.append(message);
      return;
    }

    container.classList.remove("empty-chart");
    const columns = document.createElement("div");
    columns.className = "chart-columns";

    /*
     * 시리즈가 여럿인 그래프도 같은 기준선과 최대값을 공유해야 두 막대의 길이를
     * 실제 시간 합계끼리 공정하게 비교할 수 있습니다.
     */
    const maximumValue = Math.max(
      ...entries.flatMap((entry) => series.map((item) => entry.values[item.key] || 0)),
      1
    );

    entries.forEach((entry) => {
      const column = document.createElement("div");
      column.className = "chart-column";

      const plot = document.createElement("div");
      plot.className = "chart-plot";
      plot.setAttribute("aria-label", entry.label);

      series.forEach((item) => {
        const value = entry.values[item.key] || 0;
        const bar = document.createElement("div");
        bar.className = "chart-series-bar";
        bar.setAttribute("aria-label", `${entry.label} ${item.label}: ${formatNumber(value)}`);
        bar.title = `${entry.label} · ${item.label}: ${formatNumber(value)}`;

        const fill = document.createElement("div");
        fill.className = `chart-bar-fill ${item.colorClass}`;
        const heightPercentage = (value / maximumValue) * 100;
        fill.style.height = `${heightPercentage}%`;

        const valueLabel = document.createElement("span");
        valueLabel.className = "chart-bar-value";
        valueLabel.textContent = formatNumber(value);
        valueLabel.style.bottom = `calc(${heightPercentage}% + 4px)`;

        bar.append(fill, valueLabel);
        plot.append(bar);
      });

      const label = document.createElement("span");
      label.className = "chart-category";
      label.textContent = entry.label;
      label.title = entry.label;

      column.append(plot, label);
      columns.append(column);
    });

    container.append(columns);
  }

  /*
   * 전체 데이터를 한 번 순회해 설비/날짜/모델의 롤 수와 설비별 시간 합계를 계산합니다.
   * 설비별 롤 수는 설비명 오름차순, 모델별 롤 수는 생산량 내림차순, 날짜는
   * 오름차순, 시간 비교는 로스시간이 많은 설비부터 표시합니다. YYYY-MM-DD 날짜는
   * 문자열 정렬 순서와 실제 날짜 순서가 같습니다.
   */
  function aggregateRolls(rolls) {
    const equipmentCounts = new Map();
    const dailyCounts = new Map();
    const modelCounts = new Map();
    const equipmentTimes = new Map();
    let defectCount = 0;
    let productionMinutes = 0;
    let lossMinutes = 0;

    rolls.forEach((roll) => {
      equipmentCounts.set(roll.equipment, (equipmentCounts.get(roll.equipment) || 0) + 1);
      dailyCounts.set(roll.date, (dailyCounts.get(roll.date) || 0) + 1);
      modelCounts.set(roll.model, (modelCounts.get(roll.model) || 0) + 1);
      const equipmentSummary = equipmentTimes.get(roll.equipment) || {
        productionMinutes: 0,
        lossMinutes: 0
      };
      equipmentSummary.productionMinutes += roll.productionMinutes;
      equipmentSummary.lossMinutes += roll.lossMinutes;
      equipmentTimes.set(roll.equipment, equipmentSummary);

      if (roll.judgment === "NG") {
        defectCount += 1;
      }
      productionMinutes += roll.productionMinutes;
      lossMinutes += roll.lossMinutes;
    });

    const equipmentEntries = Array.from(equipmentCounts, ([label, count]) => ({ label, count }))
      .sort((first, second) => first.label.localeCompare(second.label, "ko"));

    const dailyEntries = Array.from(dailyCounts, ([label, count]) => ({ label, count }))
      .sort((first, second) => first.label.localeCompare(second.label));

    const modelEntries = Array.from(modelCounts, ([label, count]) => ({ label, count }))
      .sort((first, second) => second.count - first.count || first.label.localeCompare(second.label, "ko"));

    const equipmentTimeEntries = Array.from(equipmentTimes, ([label, values]) => ({
      label,
      values
    })).sort((first, second) =>
      second.values.lossMinutes - first.values.lossMinutes ||
      first.label.localeCompare(second.label, "ko")
    );

    return {
      equipmentEntries,
      dailyEntries,
      modelEntries,
      equipmentTimeEntries,
      defectCount,
      productionMinutes,
      lossMinutes
    };
  }

  /*
   * 각 롤을 화면 표에 한 행씩 표시합니다. NG만 행에 별도 클래스를 부여해
   * 색으로 구분하며, 셀 내용은 textContent로 설정해 CSV 문자열을 안전하게 표시합니다.
   */
  function renderTable() {
    const visibleRolls = showNgOnly
      ? currentRolls.filter((roll) => roll.judgment === "NG")
      : currentRolls;
    const fragment = document.createDocumentFragment();

    visibleRolls.forEach((roll) => {
      const row = document.createElement("tr");
      if (roll.judgment === "NG") {
        row.classList.add("ng-row");
      }

      TABLE_COLUMNS.forEach((column) => {
        const cell = document.createElement("td");
        const value = roll[column.key];
        cell.textContent = column.fixedDecimal
          ? value.toFixed(1)
          : column.numeric
            ? formatNumber(value)
            : value;
        row.append(cell);
      });

      fragment.append(row);
    });

    if (visibleRolls.length === 0) {
      const row = document.createElement("tr");
      row.className = "placeholder-row";
      const cell = document.createElement("td");
      cell.colSpan = TABLE_COLUMNS.length;
      cell.textContent = currentRolls.length === 0
        ? "CSV를 선택하면 전체 롤 데이터가 여기에 표시됩니다."
        : "선택한 데이터에 NG 판정 롤이 없습니다.";
      row.append(cell);
      fragment.append(row);
    }

    elements.tableBody.replaceChildren(fragment);
    elements.tableCount.textContent = showNgOnly
      ? `NG ${formatNumber(visibleRolls.length)}건`
      : `전체 ${formatNumber(visibleRolls.length)}건`;
  }

  /*
   * 버튼의 선택 상태와 표의 행을 함께 갱신합니다. 두 버튼 모두 파일을 읽은 뒤에
   * 활성화하며, aria-pressed도 동기화해 키보드/보조기술 사용자에게 상태를 알립니다.
   */
  function setTableFilter(ngOnly) {
    showNgOnly = ngOnly;
    elements.showAllButton.classList.toggle("is-active", !ngOnly);
    elements.showNgButton.classList.toggle("is-active", ngOnly);
    elements.showAllButton.setAttribute("aria-pressed", String(!ngOnly));
    elements.showNgButton.setAttribute("aria-pressed", String(ngOnly));
    renderTable();
  }

  /*
   * 모든 데이터 시각화를 같은 정제된 행 배열에서 갱신합니다. 가동률의 분자는
   * 생산시간의 합계이고, 분모는 생산시간과 로스시간의 합계입니다. 두 합계가
   * 모두 0이면 0%로 표시해 NaN 또는 Infinity가 화면에 나타나지 않게 합니다.
   */
  function renderDashboard(rolls) {
    const summary = aggregateRolls(rolls);
    const defectRate = (summary.defectCount / rolls.length) * 100;
    const totalTrackedMinutes = summary.productionMinutes + summary.lossMinutes;
    const utilizationRate = totalTrackedMinutes === 0
      ? 0
      : (summary.productionMinutes / totalTrackedMinutes) * 100;
    const dates = rolls.map((roll) => roll.date).sort();

    elements.totalRolls.textContent = formatNumber(rolls.length);
    elements.defectRate.textContent = formatPercentage(defectRate);
    elements.defectDetail.textContent =
      `NG ${formatNumber(summary.defectCount)}롤 / 전체 ${formatNumber(rolls.length)}롤`;
    elements.utilizationRate.textContent = formatPercentage(utilizationRate);
    elements.totalLossTime.textContent = `${formatNumber(summary.lossMinutes)}분`;
    elements.allRowCount.textContent = formatNumber(rolls.length);
    elements.ngRowCount.textContent = formatNumber(summary.defectCount);
    elements.showAllButton.disabled = false;
    elements.showNgButton.disabled = false;
    elements.dateRange.textContent = dates[0] === dates[dates.length - 1]
      ? dates[0]
      : `${dates[0]} ~ ${dates[dates.length - 1]}`;

    renderVerticalChart(
      elements.equipmentChart,
      summary.equipmentEntries.map((entry) => ({
        label: entry.label,
        values: { rolls: entry.count }
      })),
      [{ key: "rolls", label: "생산 롤 수", colorClass: "bar-fill-blue" }],
      "표시할 설비별 생산 데이터가 없습니다."
    );
    renderVerticalChart(
      elements.dailyChart,
      summary.dailyEntries.map((entry) => ({
        label: entry.label,
        values: { rolls: entry.count }
      })),
      [{ key: "rolls", label: "생산 롤 수", colorClass: "bar-fill-violet" }],
      "표시할 일자별 생산 데이터가 없습니다."
    );
    renderVerticalChart(
      elements.modelChart,
      summary.modelEntries.map((entry) => ({
        label: entry.label,
        values: { rolls: entry.count }
      })),
      [{ key: "rolls", label: "생산 롤 수", colorClass: "bar-fill-green" }],
      "표시할 모델별 생산 데이터가 없습니다."
    );
    renderVerticalChart(
      elements.equipmentTimeChart,
      summary.equipmentTimeEntries,
      [
        { key: "productionMinutes", label: "생산시간(분)", colorClass: "bar-fill-blue" },
        { key: "lossMinutes", label: "로스시간(분)", colorClass: "bar-fill-amber" }
      ],
      "표시할 설비별 시간 데이터가 없습니다."
    );
    renderTable();
  }

  /*
   * 새 파일을 읽는 동안 기존 대시보드는 그대로 유지합니다. 파일 전체 검증과
   * 변환이 성공한 뒤에만 화면을 한 번에 갱신하므로, 잘못된 CSV가 들어와도
   * 일부 카드/차트/표만 새 데이터로 바뀌는 상태를 만들지 않습니다.
   */
  async function handleFileSelection(event) {
    const file = event.target.files[0];
    if (!file) {
      return;
    }

    elements.status.classList.remove("is-error");
    elements.status.textContent = `${file.name} 파일을 읽는 중입니다...`;

    try {
      const text = await readCsvFile(file);
      const rows = parseCsvText(text);
      const rolls = convertRowsToRolls(rows);
      currentRolls = rolls;
      setTableFilter(false);
      renderDashboard(rolls);
      elements.status.textContent = `${file.name} · ${formatNumber(rolls.length)}개 롤 데이터를 불러왔습니다.`;
    } catch (error) {
      elements.status.classList.add("is-error");
      elements.status.textContent = `CSV를 불러오지 못했습니다: ${error.message}`;
    }
  }

  elements.fileInput.addEventListener("change", handleFileSelection);
  elements.showAllButton.addEventListener("click", () => setTableFilter(false));
  elements.showNgButton.addEventListener("click", () => setTableFilter(true));
})();
