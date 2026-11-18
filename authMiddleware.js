import jwt from "jsonwebtoken";

/* ============================= REQUIRE USER ============================= */
/*
  Player token check (5001 login server jaisa hi):
  - token sahi aur expire na hua ho
  - account active ho (banned/suspended na ho)
  - token_version match kare (session revoke na hua ho)

  Success par req.player me profile_id aur email milta hai.
*/

export const createRequireUser = (supabase) => {
  return async (req, res, next) => {
    try {
      const secret = process.env.SUPPORT_JWT_SECRET;

      if (!secret || secret.length < 32) {
        console.error("❌ SUPPORT_JWT_SECRET missing or too short");

        return res.status(500).json({
          success: false,
          message: "Server auth is not configured",
        });
      }

      const authHeader = req.headers.authorization || "";

      const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : null;

      if (!token) {
        return res.status(401).json({
          success: false,
          message: "Login required",
        });
      }

      const decoded = jwt.verify(token, secret, {
        issuer: "bgmi-user-server",
        audience: "bgmi-support",
        algorithms: ["HS256"],
      });

      if (decoded.role !== "player" || !decoded.profile_id || !decoded.email) {
        return res.status(403).json({
          success: false,
          message: "Not allowed",
        });
      }

      const { data: user, error } = await supabase
        .from("registeruser")
        .select(
          "profile_id, email, account_status, suspended_until, token_version"
        )
        .eq("profile_id", decoded.profile_id)
        .eq("email", decoded.email)
        .maybeSingle();

      if (error) {
        console.error("❌ USER AUTH DB ERROR:", error.message);

        return res.status(500).json({
          success: false,
          message: "Could not verify account",
        });
      }

      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Account not found. Please login again.",
        });
      }

      // Banned ya suspended account deposit nahi kar sakta
      if ((user.account_status || "active") !== "active") {
        return res.status(403).json({
          success: false,
          message: "Your account is not active. Please login again.",
        });
      }

      // Purana ya revoke hua token reject
      if (
        Number(decoded.token_version || 0) !== Number(user.token_version || 0)
      ) {
        return res.status(401).json({
          success: false,
          message: "Your session has been revoked. Please login again.",
        });
      }

      req.player = {
        profile_id: user.profile_id,
        email: user.email,
      };

      next();
    } catch (err) {
      console.error("❌ USER AUTH ERROR:", err.message);

      return res.status(401).json({
        success: false,
        message: "Session expired or invalid. Please login again.",
      });
    }
  };
};

/* ============================= REQUIRE ADMIN ============================= */
/*
  Admin token check:
  - JWT_SECRET se verify
  - role === "admin" aur sid ho
  - admin_sessions table me session mile aur revoke na hua ho

  Success par req.admin me admin_id (session se) milta hai.
*/

export const createRequireAdmin = (supabase) => {
  return async (req, res, next) => {
    try {
      const secret = process.env.JWT_SECRET;

      if (!secret || secret.length < 32) {
        console.error("❌ JWT_SECRET missing or too short");

        return res.status(500).json({
          success: false,
          message: "Server admin auth is not configured",
        });
      }

      const authHeader = req.headers.authorization || "";

      const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : null;

      if (!token) {
        return res.status(401).json({
          success: false,
          message: "Admin login required",
        });
      }

      const decoded = jwt.verify(token, secret);

      if (decoded.role !== "admin") {
        return res.status(403).json({
          success: false,
          message: "Admin access only",
        });
      }

      if (!decoded.sid) {
        return res.status(401).json({
          success: false,
          message: "Session ID missing. Please login again.",
        });
      }

      const { data: session, error } = await supabase
        .from("admin_sessions")
        .select("id, admin_id, is_revoked")
        .eq("id", decoded.sid)
        .maybeSingle();

      if (error) {
        console.error("❌ ADMIN SESSION CHECK ERROR:", error.message);

        return res.status(500).json({
          success: false,
          message: "Could not verify admin session",
        });
      }

      if (!session) {
        return res.status(401).json({
          success: false,
          message: "Admin session not found. Please login again.",
        });
      }

      if (session.is_revoked === true) {
        return res.status(401).json({
          success: false,
          message: "Your session has been revoked. Please login again.",
          code: "SESSION_REVOKED",
        });
      }

      req.admin = {
        ...decoded,
        admin_id: String(session.admin_id),
      };

      next();
    } catch (err) {
      console.error("❌ ADMIN AUTH ERROR:", err.message);

      return res.status(401).json({
        success: false,
        message: "Invalid or expired admin session",
      });
    }
  };
};