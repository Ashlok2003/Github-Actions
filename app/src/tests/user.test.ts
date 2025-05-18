import request from "supertest";
import app from "../app";

describe("User Routes", () => {
  it("GET /api/users should return all users", async () => {
    const res = await request(app).get("/api/users");
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("POST /api/users should create a user", async () => {
    const res = await request(app)
      .post("/api/users")
      .send({ id: 3, name: "Charlie" });

    expect(res.statusCode).toBe(201);
    expect(res.body.user).toEqual({ id: 3, name: "Charlie" });
  });
});
