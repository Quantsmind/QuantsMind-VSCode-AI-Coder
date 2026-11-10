package com.demo.controller;

import com.demo.service.UserService;
import com.demo.dto.CreateUserRequest;

public class UserController {
    private final UserService userService;

    public UserController(UserService userService) {
        this.userService = userService;
    }

    public String create(CreateUserRequest request) {
        return userService.create(request);
    }
}
