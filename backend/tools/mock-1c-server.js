/**
 * Мок HTTP-сервисов 1С по «ТЗ для запросов GET», v10.
 *
 * Нужен, пока боевой 10.10.10.81 недоступен: позволяет отладить весь цикл
 * приёма — разбор номера, запрос, маппинг, запись в базу — на данных той же
 * формы, что отдаёт настоящая 1С.
 *
 * Отвечает на четыре пути из Лист3:
 *   GET /erp/hs/fm/orders?clientorder_num=…&clientorder_year=…  (или clientorder_adem)
 *   GET /erp/hs/fm/invoices?invoice_num=…&invoice_year=…
 *   GET /erp/hs/TurnOver/v1/get_c?supplier_invoice_num=…&supplier_invoice_year=…
 *   GET /erp/hs/TurnOver/v1/get_d?clientorder_num=…&clientorder_year=…
 *
 * Запуск: node tools/mock-1c-server.js [порт]
 * Затем:  ONEC_BASE_URL=http://localhost:8081 npm run start:dev
 */
const http = require('http');
const { URL } = require('url');

const PORT = Number(process.argv[2] || 8081);

/** Номенклатура, которая точно есть в нашей базе (из «Спецификаций 2022») */
const KNOWN_ITEMS = [
  { item: 'U-болт под трубу ф76мм', item_code: 'k-001', qty: 12, unitprice: 715, tax: 12, amount: 9604.8 },
  { item: 'U-болт под трубу ф102мм', item_code: 'k-002', qty: 5, unitprice: 890, tax: 12, amount: 4984 },
];

/** Артикул, которого у нас нет — проверяем, что синхронизация не создаёт его молча */
const UNKNOWN_ITEM = {
  item: 'Кронштейн специальный НОВЫЙ', item_code: 'x-999', qty: 3, unitprice: 5000, tax: 12, amount: 16800,
};

function clientOrder(num, adem, year) {
  return {
    clientorder_num: num,
    clientorder_adem: adem,
    clientorder_date: '2026-03-12T00:00:00',
    clientorder_year: year,
    client_po: 'PO-2026-114',
    clientorder_status: 'К выполнению',
    clientorder_approval_status: 'Согласован',
    workplandate: '2026-09-30T00:00:00',
    client_agreement: 'ДС-2024-17',
    client_agreement_signdate: '2024-02-01T00:00:00',
    division_code: '7П',
    client: 'КарТел',
    client_bin: '990140000593',
    final_client: '',
    our_company: 'Аврора 77, ТОО',
    our_bin: '191140005579',
    project_group: 'Телеком',
    project_site: 'KZ-Теле2-2025',
    region: 'Алматы',
    project_manager: 'Жаксылык А.',
    business_direction: 'Металлоконструкции',
    work_type: 'Изготовление',
    project_type: 'Поставка',
    description: 'Доп. комплектация БС (мок)',
    author: 'Оператор 1С',
    // Имя массива в ТЗ не указано — отдаём под именем items;
    // клиент должен уметь и другие варианты (см. findItemsArray)
    items: [...KNOWN_ITEMS, UNKNOWN_ITEM],
    clientorder_pay_data: [
      { clientorder_paid_amount: 5000, clientorder_invoice_id: 'СЧ-000123', clientorder_paydate: '2026-04-01T00:00:00' },
      { clientorder_paid_amount: 3000, clientorder_invoice_id: 'СЧ-000456', clientorder_paydate: '2026-05-15T00:00:00' },
    ],
  };
}

function supplierOrder(num, adem) {
  return {
    supplier_invoice_num: num,
    supplier_invoice_adem: adem,
    supplier_invoice_date: '2026-03-20T00:00:00',
    supplier_invoice_status: 'Утвержден',
    supplier_invoice_ext: 'СФ-9912',
    supplier_agreement: 'ДП-2025-4',
    project_group: 'Телеком',
    region: 'Алматы',
    buyer: 'Закупщик А.',
    approver: 'Директор',
    our_company: 'Аврора 77, ТОО',
    our_bin: '191140005579',
    supplier: 'ТОО Металлбаза-Мок',
    supplier_bin: '050340004321',
    description: 'Труба профильная под заказ',
    supplier_invoice_category: 'ТМЦ',
    supplier_invoice_notpaid_amount: 120000,
    currency: 'KZT',
    supplier_invoice_alldata: [
      { supplier_invoice_paid_amount: 380000, supplier_invoice_id: 'ПП-0091', supplier_invoice_paydate: '2026-04-05T00:00:00' },
    ],
    item_alldata: [
      {
        item: 'Труба проф. 120х120х4мм', item_code: 'MET-001', expense_category: 'Сырьё',
        qty: 1.389, unit_measure: 'тн', unit_price: 446000, tax: 12,
        clientorder_num: 'Т7АА-001211', clientorder_date: '2026-03-12T00:00:00', amount: 500000,
      },
    ],
    actdoc_alldata: [
      {
        actdoc_num: 'АСАА-000342', actdoc_num_ext: '2315',
        // Именно такой формат даты приведён в ТЗ — клиент обязан его разбирать
        actdoc_date: 'Wed May 13 2026 05:00:00 GMT+0500 (Kazakhstan Time)',
        actdoc_processed_date: 'Mon May 18 2026 05:00:00 GMT+0500 (Kazakhstan Time)',
        actdoc_amount: 500000, esf_num: 'ЭСФ-77123', esf_date: '2026-05-14T00:00:00',
      },
    ],
  };
}

function turnover(num, adem) {
  return {
    clientorder_num: num,
    clientorder_adem: adem,
    clientorder_date: '2026-03-12T00:00:00',
    supplier_invoice_alldata: [
      {
        supplier_invoice_num: '00АА-066433', supplier_invoice_adem: '1151185',
        supplier_invoice_date: '2026-03-20T00:00:00', supplier_invoice_year: '2026',
        supplier: 'ТОО Металлбаза-Мок', supplier_bin: '050340004321', currency: 'KZT',
        item: 'Труба проф. 120х120х4мм', item_amount: 500000, item_paid_amount: 380000,
      },
    ],
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const q = Object.fromEntries(url.searchParams);
  const send = (data, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };

  console.log(`[мок 1С] ${req.method} ${url.pathname} ${JSON.stringify(q)}`);

  if (url.pathname === '/erp/hs/fm/orders') {
    const num = q.clientorder_num || '';
    const adem = q.clientorder_adem || '';
    if (!num && !adem) return send({ error: 'Не указан номер заказа' }, 400);
    // Неизвестный номер — пустой массив, как это делает 1С
    if (/ROW/i.test(num + adem)) return send([]);
    return send([clientOrder(num || 'Т7АА-001211', adem || 'П-115480-24', q.clientorder_year || '2026')]);
  }

  if (url.pathname === '/erp/hs/fm/invoices') {
    return send([{
      clientorder_num: 'Т7АА-001211', clientorder_adem: 'П-115480-24',
      client_invoice_num: q.invoice_num || 'АСАА-006698',
      client_invoice_date: '2026-04-01T00:00:00',
      payamount: 5000, percent: 35, ispaid: 'Оплачено частично',
      currency: 'KZT', client_invoice_type: 'Счет',
      pay_plandate: '2026-05-01T00:00:00', pay_factdate: '2026-04-01T00:00:00',
      esf_num: 'ЭСФ-55021', esf_date: '2026-04-02T00:00:00',
    }]);
  }

  if (url.pathname === '/erp/hs/TurnOver/v1/get_c') {
    const num = q.supplier_invoice_num || '';
    const adem = q.supplier_invoice_adem || '';
    if (!num && !adem) return send({ error: 'Не указан номер заказа поставщику' }, 400);
    return send([supplierOrder(num || '00АА-066433', adem || '1151185')]);
  }

  if (url.pathname === '/erp/hs/TurnOver/v1/get_d') {
    const num = q.clientorder_num || '';
    const adem = q.clientorder_adem || '';
    if (!num && !adem) return send({ error: 'Не указан номер заказа клиента' }, 400);
    if (/ROW/i.test(num + adem)) return send([]);
    return send([turnover(num || 'Т7АА-001211', adem || 'П-115480-24')]);
  }

  send({ error: `Неизвестный путь ${url.pathname}` }, 404);
});

server.listen(PORT, () => {
  console.log(`Мок 1С слушает http://localhost:${PORT}`);
  console.log('Пути: /erp/hs/fm/orders, /erp/hs/fm/invoices, /erp/hs/TurnOver/v1/get_c, /erp/hs/TurnOver/v1/get_d');
});
