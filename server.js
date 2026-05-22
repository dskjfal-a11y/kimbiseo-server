const express = require("express");
const cors = require("cors");
const axios = require("axios");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

const IMWEB_API_KEY = process.env.IMWEB_API_KEY;
const IMWEB_SECRET_KEY = process.env.IMWEB_SECRET_KEY;
const ORDER_VERSION = process.env.ORDER_VERSION || "v2";

const SUBSCRIPTION_KEYWORDS = (process.env.SUBSCRIPTION_KEYWORDS || "정기구독,김비서 고용하기")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const PAID_SERVICE_KEYWORDS = (process.env.PAID_SERVICE_KEYWORDS || "유료,별도결제,추가결제,유료 서비스")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const GOOGLE_SHEET_WEBHOOK_URL = process.env.GOOGLE_SHEET_WEBHOOK_URL || "";

const DATA_DIR = path.join(__dirname, "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function normalizePhone(value) {
  return String(value || "").replace(/[^0-9]/g, "");
}

function includesAnyKeyword(text, keywords) {
  const source = String(text || "");
  return keywords.some((keyword) => source.includes(keyword));
}

function findDeepValue(obj, keys) {
  if (!obj || typeof obj !== "object") return "";

  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) {
      return obj[key];
    }
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      const found = findDeepValue(value, keys);
      if (found !== "" && found !== undefined && found !== null) return found;
    }
  }

  return "";
}

function extractList(responseData) {
  if (!responseData) return [];

  if (Array.isArray(responseData)) return responseData;

  if (Array.isArray(responseData.list)) return responseData.list;
  if (Array.isArray(responseData.data)) return responseData.data;
  if (Array.isArray(responseData.items)) return responseData.items;

  if (responseData.data && Array.isArray(responseData.data.list)) return responseData.data.list;
  if (responseData.result && Array.isArray(responseData.result.list)) return responseData.result.list;

  return [];
}

async function getImwebAccessToken() {
  if (!IMWEB_API_KEY || !IMWEB_SECRET_KEY) {
    throw new Error("IMWEB_API_KEY 또는 IMWEB_SECRET_KEY가 설정되지 않았습니다.");
  }

  const url = "https://api.imweb.me/v2/auth";

  const response = await axios.get(url, {
    params: {
      key: IMWEB_API_KEY,
      secret: IMWEB_SECRET_KEY
    },
    timeout: 15000
  });

  const data = response.data;

  if (!data || data.code !== 200 || !data.access_token) {
    throw new Error(`아임웹 토큰 발급 실패: ${JSON.stringify(data)}`);
  }

  return data.access_token;
}

async function imwebGet(pathname, accessToken, params = {}) {
  const response = await axios.get(`https://api.imweb.me${pathname}`, {
    headers: {
      "access-token": accessToken
    },
    params,
    timeout: 20000
  });

  return response.data;
}

async function getMembers(accessToken) {
  const data = await imwebGet("/v2/member/members", accessToken);
  return extractList(data);
}

async function getOrders(accessToken) {
  const data = await imwebGet("/v2/shop/orders", accessToken);
  return extractList(data);
}

async function getProdOrders(accessToken, orderNoOrCode) {
  if (!orderNoOrCode) return [];

  try {
    const data = await imwebGet(
      `/v2/shop/orders/${encodeURIComponent(orderNoOrCode)}/prod-orders`,
      accessToken,
      { order_version: ORDER_VERSION }
    );

    return extractList(data);
  } catch (error) {
    return [];
  }
}

function getMemberName(member) {
  return String(
    findDeepValue(member, [
      "name",
      "member_name",
      "username",
      "user_name",
      "nick",
      "nickname",
      "display_name"
    ]) || ""
  );
}

function getMemberPhone(member) {
  return normalizePhone(
    findDeepValue(member, [
      "phone",
      "mobile",
      "cellphone",
      "callnum",
      "call_num",
      "phone_number",
      "member_phone",
      "tel"
    ])
  );
}

function getMemberEmail(member) {
  return String(
    findDeepValue(member, [
      "email",
      "member_email",
      "user_email"
    ]) || ""
  );
}

function matchMember(members, inputName, inputPhone) {
  const normalizedInputPhone = normalizePhone(inputPhone);
  const inputNameText = String(inputName || "").trim();

  return members.find((member) => {
    const memberName = getMemberName(member);
    const memberPhone = getMemberPhone(member);

    const phoneMatched =
      normalizedInputPhone &&
      memberPhone &&
      memberPhone.includes(normalizedInputPhone);

    const nameMatched =
      inputNameText &&
      memberName &&
      memberName.includes(inputNameText);

    if (normalizedInputPhone && inputNameText) {
      return phoneMatched && nameMatched;
    }

    if (normalizedInputPhone) return phoneMatched;
    if (inputNameText) return nameMatched;

    return false;
  });
}

function getOrderText(order, prodOrders = []) {
  return JSON.stringify({
    order,
    prodOrders
  });
}

function isOrderCompleted(orderText) {
  const text = String(orderText || "");

  const completedKeywords = [
    "결제완료",
    "배송준비",
    "배송중",
    "배송완료",
    "구매확정",
    "paid",
    "complete",
    "completed"
  ];

  const badKeywords = [
    "취소",
    "환불",
    "반품",
    "미결제",
    "입금대기",
    "cancel",
    "refund"
  ];

  const hasCompleted = completedKeywords.some((keyword) =>
    text.toLowerCase().includes(keyword.toLowerCase())
  );

  const hasBad = badKeywords.some((keyword) =>
    text.toLowerCase().includes(keyword.toLowerCase())
  );

  return hasCompleted && !hasBad;
}

async function analyzeCustomer(accessToken, inputName, inputPhone) {
  const members = await getMembers(accessToken);
  const matchedMember = matchMember(members, inputName, inputPhone);

  if (!matchedMember) {
    return {
      ok: true,
      isMember: false,
      canUseService: false,
      subscriptionActive: false,
      paidServiceCompleted: false,
      reason: "아임웹 회원정보에서 고객을 찾지 못했습니다.",
      input: {
        name: inputName || "",
        phone: inputPhone || ""
      }
    };
  }

  const orders = await getOrders(accessToken);

  const matchedPhone = getMemberPhone(matchedMember);
  const matchedName = getMemberName(matchedMember);
  const matchedEmail = getMemberEmail(matchedMember);

  const relatedOrders = orders.filter((order) => {
    const orderText = JSON.stringify(order);
    const orderPhone = normalizePhone(orderText);

    const phoneMatched = matchedPhone && orderPhone.includes(matchedPhone);
    const nameMatched = matchedName && orderText.includes(matchedName);
    const emailMatched = matchedEmail && orderText.includes(matchedEmail);

    return phoneMatched || nameMatched || emailMatched;
  });

  const checkedOrders = [];

  for (const order of relatedOrders.slice(0, 10)) {
    const orderNo =
      order.order_no ||
      order.order_code ||
      order.orderCode ||
      order.orderNo ||
      "";

    const prodOrders = await getProdOrders(accessToken, orderNo);
    const orderText = getOrderText(order, prodOrders);

    checkedOrders.push({
      order,
      prodOrders,
      orderText,
      isCompleted: isOrderCompleted(orderText),
      hasSubscriptionKeyword: includesAnyKeyword(orderText, SUBSCRIPTION_KEYWORDS),
      hasPaidServiceKeyword: includesAnyKeyword(orderText, PAID_SERVICE_KEYWORDS)
    });
  }

  const subscriptionActive = checkedOrders.some(
    (item) => item.hasSubscriptionKeyword && item.isCompleted
  );

  const paidServiceCompleted = checkedOrders.some(
    (item) => item.hasPaidServiceKeyword && item.isCompleted
  );

  const canUseService = subscriptionActive || paidServiceCompleted;

  return {
    ok: true,
    isMember: true,
    canUseService,
    subscriptionActive,
    paidServiceCompleted,
    reason: canUseService
      ? "이용 가능한 고객입니다."
      : "회원은 확인되었지만 정기구독 또는 유료 서비스 결제완료 내역을 찾지 못했습니다.",
    customer: {
      name: matchedName,
      phone: matchedPhone,
      email: matchedEmail
    },
    matchedMember,
    relatedOrderCount: relatedOrders.length,
    checkedOrders: checkedOrders.map((item) => ({
      order_no: item.order.order_no || "",
      order_code: item.order.order_code || "",
      isCompleted: item.isCompleted,
      hasSubscriptionKeyword: item.hasSubscriptionKeyword,
      hasPaidServiceKeyword: item.hasPaidServiceKeyword,
      prodOrderCount: item.prodOrders.length
    }))
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "kimbiseo-server",
    message: "김비서 중간서버가 실행 중입니다."
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "healthy",
    time: new Date().toISOString()
  });
});

app.post("/customer-profile", async (req, res) => {
  try {
    const body = req.body || {};
    const name = body.name || body.customerName || "";
    const phone = body.phone || "";

    const accessToken = await getImwebAccessToken();
    const result = await analyzeCustomer(accessToken, name, phone);

    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
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
      raw: body
    };

    const orders = readJsonFile(ORDERS_FILE, []);
    orders.push(order);
    writeJsonFile(ORDERS_FILE, orders);

    let googleSheet = {
      sent: false,
      message: "GOOGLE_SHEET_WEBHOOK_URL이 설정되지 않았습니다."
    };

    if (GOOGLE_SHEET_WEBHOOK_URL) {
      try {
        const sheetResponse = await axios.post(GOOGLE_SHEET_WEBHOOK_URL, order, {
          headers: {
            "Content-Type": "application/json"
          },
          timeout: 15000
        });

        googleSheet = {
          sent: true,
          status: sheetResponse.status,
          data: sheetResponse.data
        };
      } catch (sheetError) {
        googleSheet = {
          sent: false,
          error: sheetError.response?.data || sheetError.message
        };
      }
    }

    res.json({
      ok: true,
      message: "오더를 저장했습니다.",
      order,
      googleSheet
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/orders", (req, res) => {
  const orders = readJsonFile(ORDERS_FILE, []);
  res.json({
    ok: true,
    count: orders.length,
    orders
  });
});

app.listen(PORT, () => {
  console.log(`Kimbiseo server running on port ${PORT}`);
});