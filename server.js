const express = require("express");
const axios = require("axios");
const cors = require("cors");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const IMWEB_API_KEY = process.env.IMWEB_API_KEY;
const IMWEB_SECRET_KEY = process.env.IMWEB_SECRET_KEY;
const ORDER_VERSION = process.env.ORDER_VERSION || "v2";
const GOOGLE_SHEET_WEBHOOK_URL = process.env.GOOGLE_SHEET_WEBHOOK_URL || "";

const SUBSCRIPTION_KEYWORDS = (
  process.env.SUBSCRIPTION_KEYWORDS ||
  "정기구독,김비서 고용하기,김비서 고용하기(정기구독),김비서 한 달 고용하기"
)
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const PAID_SERVICE_KEYWORDS = (
  process.env.PAID_SERVICE_KEYWORDS ||
  "유료 서비스,유료,별도결제,추가결제"
)
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const DATA_DIR = path.join(__dirname, "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJsonFile(filePath, defaultValue) {
  try {
    if (!fs.existsSync(filePath)) return defaultValue;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw) return defaultValue;
    return JSON.parse(raw);
  } catch (error) {
    return defaultValue;
  }
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function onlyNumber(value) {
  return String(value || "").replace(/[^0-9]/g, "");
}

function normalizeText(value) {
  return String(value || "").trim();
}

function getValueByKeys(obj, keys) {
  if (!obj || typeof obj !== "object") return "";

  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
      return obj[key];
    }
  }

  return "";
}

function flattenArrayFromResponse(data) {
  if (Array.isArray(data)) return data;

  if (data && Array.isArray(data.list)) return data.list;
  if (data && data.data && Array.isArray(data.data)) return data.data;
  if (data && data.data && Array.isArray(data.data.list)) return data.data.list;
  if (data && data.result && Array.isArray(data.result)) return data.result;
  if (data && data.result && Array.isArray(data.result.list)) return data.result.list;

  return [];
}

async function getImwebAccessToken() {
  if (!IMWEB_API_KEY || !IMWEB_SECRET_KEY) {
    throw new Error("IMWEB_API_KEY 또는 IMWEB_SECRET_KEY가 설정되지 않았습니다.");
  }

  const response = await axios.get("https://api.imweb.me/v2/auth", {
    params: {
      key: IMWEB_API_KEY,
      secret: IMWEB_SECRET_KEY,
    },
    timeout: 10000,
  });

  const data = response.data || {};

  if (data.code !== 200 || !data.access_token) {
    throw new Error(`아임웹 토큰 발급 실패: ${JSON.stringify(data)}`);
  }

  return data.access_token;
}

async function imwebGet(accessToken, url, params = {}) {
  const response = await axios.get(url, {
    headers: {
      "access-token": accessToken,
    },
    params,
    timeout: 15000,
  });

  return response.data;
}

async function getImwebMembers(accessToken) {
  const data = await imwebGet(accessToken, "https://api.imweb.me/v2/member/members");
  return flattenArrayFromResponse(data);
}

async function getImwebOrders(accessToken) {
  const data = await imwebGet(accessToken, "https://api.imweb.me/v2/shop/orders");
  return flattenArrayFromResponse(data);
}

async function getImwebProductOrders(accessToken, order) {
  const orderNo = order.order_no || order.orderNo || "";
  const orderCode = order.order_code || order.orderCode || "";

  const candidates = [orderNo, orderCode].filter(Boolean);

  for (const orderId of candidates) {
    try {
      const data = await imwebGet(
        accessToken,
        `https://api.imweb.me/v2/shop/orders/${orderId}/prod-orders`,
        {
          order_version: ORDER_VERSION,
        }
      );

      const list = flattenArrayFromResponse(data);

      if (list.length > 0) {
        return {
          orderIdUsed: orderId,
          list,
          raw: data,
        };
      }
    } catch (error) {
      // 다음 후보 orderId로 재시도
    }
  }

  return {
    orderIdUsed: "",
    list: [],
    raw: null,
  };
}

function findMember(members, inputName, inputPhone) {
  const targetName = normalizeText(inputName);
  const targetPhone = onlyNumber(inputPhone);

  return members.find((member) => {
    const memberName = normalizeText(
      getValueByKeys(member, [
        "name",
        "member_name",
        "username",
        "nick",
        "nickname",
        "user_name",
      ])
    );

    const memberPhone = onlyNumber(
      getValueByKeys(member, [
        "callnum",
        "phone",
        "mobile",
        "cellphone",
        "phone_number",
      ])
    );

    const nameMatched = targetName && memberName && memberName === targetName;
    const phoneMatched = targetPhone && memberPhone && memberPhone === targetPhone;

    if (targetName && targetPhone) {
      return nameMatched && phoneMatched;
    }

    return nameMatched || phoneMatched;
  });
}

function orderBelongsToMember(order, member, inputName, inputPhone) {
  const targetName = normalizeText(inputName || member.name);
  const targetPhone = onlyNumber(inputPhone || member.callnum);

  const memberCode = normalizeText(member.member_code);
  const memberPhone = onlyNumber(member.callnum);
  const memberName = normalizeText(member.name);

  const orderer = order.orderer || {};

  const orderMemberCode = normalizeText(orderer.member_code);
  const orderName = normalizeText(orderer.name);
  const orderPhone = onlyNumber(orderer.call);

  if (memberCode && orderMemberCode && memberCode === orderMemberCode) {
    return true;
  }

  if (memberName && orderName && memberPhone && orderPhone) {
    if (memberName === orderName && memberPhone === orderPhone) {
      return true;
    }
  }

  if (targetName && orderName && targetPhone && orderPhone) {
    if (targetName === orderName && targetPhone === orderPhone) {
      return true;
    }
  }

  return false;
}

function textIncludesAny(text, keywords) {
  const value = normalizeText(text);
  if (!value) return false;

  return keywords.some((keyword) => value.includes(keyword));
}

function getProductName(productOrder) {
  if (!productOrder || typeof productOrder !== "object") return "";

  const directName = normalizeText(
    getValueByKeys(productOrder, [
      "prod_name",
      "product_name",
      "name",
      "title",
      "prodName",
      "item_name",
      "prod_title",
      "productTitle",
    ])
  );

  if (directName) return directName;

  if (Array.isArray(productOrder.items) && productOrder.items.length > 0) {
    const itemNames = productOrder.items
      .map((item) =>
        normalizeText(
          getValueByKeys(item, [
            "prod_name",
            "product_name",
            "name",
            "title",
            "prodName",
            "item_name",
            "prod_title",
            "productTitle",
          ])
        )
      )
      .filter(Boolean);

    if (itemNames.length > 0) {
      return itemNames.join(" ");
    }
  }

  if (productOrder.product && typeof productOrder.product === "object") {
    const nestedName = normalizeText(
      getValueByKeys(productOrder.product, [
        "prod_name",
        "product_name",
        "name",
        "title",
        "prodName",
        "item_name",
      ])
    );

    if (nestedName) return nestedName;
  }

  if (productOrder.prod && typeof productOrder.prod === "object") {
    const nestedName = normalizeText(
      getValueByKeys(productOrder.prod, [
        "prod_name",
        "product_name",
        "name",
        "title",
        "prodName",
        "item_name",
      ])
    );

    if (nestedName) return nestedName;
  }

  return "";
}

function getProductStatusText(productOrder) {
  if (!productOrder || typeof productOrder !== "object") return "";

  const directStatus = normalizeText(
    getValueByKeys(productOrder, [
      "status",
      "order_status",
      "payment_status",
      "pay_status",
      "delivery_status",
      "prod_order_status",
      "status_text",
      "statusText",
    ])
  );

  const nestedStatus =
    normalizeText(productOrder.status?.text) ||
    normalizeText(productOrder.status?.name) ||
    normalizeText(productOrder.order_status?.text) ||
    normalizeText(productOrder.order_status?.name);

  return `${directStatus} ${nestedStatus}`.trim();
}

function getOrderStatusText(order, productOrders) {
  const orderStatus = normalizeText(
    getValueByKeys(order, [
      "status",
      "order_status",
      "payment_status",
      "pay_status",
      "delivery_status",
      "prod_order_status",
      "status_text",
      "statusText",
    ])
  );

  const productStatusText = productOrders
    .map((p) => getProductStatusText(p))
    .filter(Boolean)
    .join(" ");

  return `${orderStatus} ${productStatusText}`.trim();
}

function isPaidOrder(order) {
  const payment = order.payment || {};

  const paymentAmount = Number(payment.payment_amount || 0);
  const totalPrice = Number(payment.total_price || 0);
  const paymentTime = Number(payment.payment_time || 0);

  if (paymentTime > 0 && paymentAmount > 0) return true;
  if (paymentTime > 0 && totalPrice >= 0) return true;

  return false;
}

function isCompletedPayment(order, productOrders) {
  const statusText = getOrderStatusText(order, productOrders);

  const negativeWords = [
    "취소",
    "환불",
    "반품",
    "미결제",
    "입금대기",
    "실패",
    "cancel",
    "refund",
    "failed",
  ];

  const positiveWords = [
    "결제완료",
    "구매확정",
    "구매 확정",
    "배송준비",
    "배송중",
    "배송완료",
    "구매완료",
    "완료",
    "paid",
    "complete",
    "completed",
  ];

  const lower = statusText.toLowerCase();

  if (negativeWords.some((word) => lower.includes(word.toLowerCase()))) {
    return false;
  }

  if (positiveWords.some((word) => lower.includes(word.toLowerCase()))) {
    return true;
  }

  return isPaidOrder(order);
}

async function analyzeCustomer(inputName, inputPhone) {
  const accessToken = await getImwebAccessToken();

  const members = await getImwebMembers(accessToken);
  const member = findMember(members, inputName, inputPhone);

  if (!member) {
    return {
      ok: true,
      isMember: false,
      canUseService: false,
      subscriptionActive: false,
      paidServiceCompleted: false,
      reason: "아임웹 회원정보에서 고객을 찾지 못했습니다.",
      input: {
        name: inputName || "",
        phone: inputPhone || "",
      },
    };
  }

  const orders = await getImwebOrders(accessToken);

  const matchedOrders = orders.filter((order) =>
    orderBelongsToMember(order, member, inputName, inputPhone)
  );

  let subscriptionActive = false;
  let paidServiceCompleted = false;
  let matchedProducts = [];

  for (const order of matchedOrders) {
    const productOrderResult = await getImwebProductOrders(accessToken, order);
    const productOrders = productOrderResult.list || [];

    const orderNo = order.order_no || "";
    const orderCode = order.order_code || "";

    for (const product of productOrders) {
      const productName = getProductName(product);
      const completed = isCompletedPayment(order, productOrders);

      const productResult = {
        orderNo,
        orderCode,
        orderIdUsed: productOrderResult.orderIdUsed,
        productName,
        completed,
        raw: product,
      };

      matchedProducts.push(productResult);

      if (completed && textIncludesAny(productName, SUBSCRIPTION_KEYWORDS)) {
        subscriptionActive = true;
      }

      if (completed && textIncludesAny(productName, PAID_SERVICE_KEYWORDS)) {
        paidServiceCompleted = true;
      }
    }

    if (productOrders.length === 0 && isPaidOrder(order)) {
      matchedProducts.push({
        orderNo,
        orderCode,
        orderIdUsed: productOrderResult.orderIdUsed,
        productName: "",
        completed: true,
        raw: null,
      });
    }
  }

  const canUseService = subscriptionActive || paidServiceCompleted;

  return {
    ok: true,
    isMember: true,
    canUseService,
    subscriptionActive,
    paidServiceCompleted,
    reason: canUseService
      ? "이용 가능한 고객입니다."
      : "회원은 확인되었지만 정기구독 또는 유료 서비스 결제 내역을 찾지 못했습니다.",
    input: {
      name: inputName || "",
      phone: inputPhone || "",
    },
    member,
    orders: matchedOrders,
    products: matchedProducts,
    debug: {
      totalOrders: orders.length,
      matchedOrders: matchedOrders.length,
      matchedProducts: matchedProducts.length,
      subscriptionKeywords: SUBSCRIPTION_KEYWORDS,
      paidServiceKeywords: PAID_SERVICE_KEYWORDS,
    },
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "kimbiseo-server",
    message: "김비서 중간서버가 실행 중입니다.",
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "김비서 서버 정상 작동 중",
  });
});

app.post("/customer-profile", async (req, res) => {
  try {
    const body = req.body || {};
    const name = body.name || body.customerName || "";
    const phone = body.phone || "";

    const result = await analyzeCustomer(name, phone);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/orders/create", async (req, res) => {
  try {
    const body = req.body || {};

    const order = {
      id: Date.now().toString(),
      createdAt: new Date().toISOString(),
      customerName: body.customerName || "",
      phone: body.phone || "",
      requestSummary: body.requestSummary || "",
      taskType: body.taskType || "",
      place: body.place || "",
      deadline: body.deadline || "",
      item: body.item || "",
      budget: body.budget || "",
      deliveryPlace: body.deliveryPlace || "",
      photoRequired: body.photoRequired || "",
      priceType: body.priceType || "",
      conversationSummary: body.conversationSummary || "",
      raw: body,
    };

    const orders = readJsonFile(ORDERS_FILE, []);
    orders.push(order);
    writeJsonFile(ORDERS_FILE, orders);

    let googleSheet = {
      sent: false,
      message: "GOOGLE_SHEET_WEBHOOK_URL이 설정되지 않았습니다.",
    };

    if (GOOGLE_SHEET_WEBHOOK_URL) {
      try {
        const sheetResponse = await axios.post(GOOGLE_SHEET_WEBHOOK_URL, order, {
          headers: {
            "Content-Type": "application/json",
          },
          timeout: 10000,
        });

        googleSheet = {
          sent: true,
          status: sheetResponse.status,
          data: sheetResponse.data,
        };
      } catch (sheetError) {
        googleSheet = {
          sent: false,
          error: sheetError.response?.data || sheetError.message,
        };
      }
    }

    res.json({
      ok: true,
      message: "오더를 저장했습니다.",
      order,
      googleSheet,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/orders", (req, res) => {
  const orders = readJsonFile(ORDERS_FILE, []);

  res.json({
    ok: true,
    count: orders.length,
    orders: orders.slice().reverse(),
  });
});

app.listen(PORT, () => {
  console.log(`Kimbiseo server running on port ${PORT}`);
});