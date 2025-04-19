import axios from "axios";

const BASE_URL = "http://localhost:3000/api";

const login = async (credentials) => {
  const res = await axios.post(`${BASE_URL}/login`, credentials);
  return res.data;
};

export default {
  login,
};
