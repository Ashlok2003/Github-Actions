import express from "express";
import userRoutes from "./routes/user.routes";
import healthRoutes from "./routes/health.routes";
const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).json({ message: "Welcome to the API" });
});

app.use("/api/users", userRoutes);
app.use("/api/health", healthRoutes);

export default app;
