import { Request, Response } from "express";

export const getUsers = (req: Request, res: Response) => {
  res.json([
    { id: 1, name: "Ashlok Chaudhary" },
    { id: 2, name: "Rajesh Chaudhary" },
  ]);
};

export const createUser = (req: Request, res: Response) => {
  const user = req.body;
  res.status(201).json({ message: "User created", user });
};
