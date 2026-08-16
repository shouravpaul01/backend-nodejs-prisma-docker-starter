import Redis from "ioredis";

// BullMQ requires maxRetriesPerRequest: null to prevent side effects in queue processing
const bullmqRedis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

bullmqRedis.on("connect", () => console.log("BullMQ Redis successfully connected"));
bullmqRedis.on("error", (err) => console.error("BullMQ Redis error:", err));

export default bullmqRedis;
