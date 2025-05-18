import express from "express";
import userRoutes from "./routes/user.routes";

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).json({ message: "Welcome to the API" });
});

app.use("/api/users", userRoutes);

export default app;
