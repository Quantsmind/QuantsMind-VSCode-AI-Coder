package com.demo.repository;

public class UserRepository {
    public String save(String name) {
        return "saved:" + name;
    }

    public String findById(Long id) {
        return "user-" + id;
    }
}
