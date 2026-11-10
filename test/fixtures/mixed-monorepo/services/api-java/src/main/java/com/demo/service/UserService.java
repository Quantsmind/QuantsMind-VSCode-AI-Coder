package com.demo.service;

import com.demo.repository.UserRepository;
import com.demo.dto.CreateUserRequest;
import com.demo.model.User;

public class UserService {
    private final UserRepository repository;

    public UserService(UserRepository repository) {
        this.repository = repository;
    }

    public String create(CreateUserRequest request) {
        User user = new User();
        user.name = request.name;
        return repository.save(user.name);
    }
}
